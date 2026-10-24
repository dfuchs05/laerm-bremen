-- =============================================================================
-- Lärmkarte Bremen – komplette Datenbank in einer Datei.
--
-- Einmal im Supabase-Dashboard unter "SQL Editor" einfügen und "Run" klicken.
-- Die Datei darf auch mehrfach ausgeführt werden (z. B. nach Änderungen);
-- vorhandene Meldungen bleiben dabei erhalten.
--
-- Prinzip: Der Browser darf die Tabelle nur LESEN. Schreiben geht nur über
-- die Edge Functions (Captcha-Prüfung), die dann submit_report bzw.
-- flag_report aufrufen. Diese prüfen alle übrigen Regeln.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Geheimer Salt für den Geräte-Hash. Liegt im Schema "private", das Supabase
-- nicht über die API ausliefert. Wird beim ersten Ausführen zufällig erzeugt.
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  id   boolean primary key default true check (id),
  salt text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into private.settings default values on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------

-- Bounding Box der Stadtgemeinde Bremen (ohne Bremerhaven).
create or replace function public.in_bremen_bbox(p_lat double precision, p_lng double precision)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select p_lat between 53.010 and 53.230 and p_lng between 8.480 and 8.995;
$$;

-- Entfernung in Metern (Haversine).
create or replace function public.distance_m(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision
)
returns double precision language sql immutable parallel safe set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- HTML-Tags und Steuerzeichen entfernen, Leerraum zusammenfassen, max. 200 Zeichen.
create or replace function public.sanitize_comment(p_comment text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(regexp_replace(
    coalesce(p_comment, ''), '<[^>]*>?', '', 'g'), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), 200), '');
$$;

-- Gesalzener Hash (HMAC-SHA256) der zufälligen Browser-ID.
-- Die ID selbst wird nirgends gespeichert.
create or replace function private.device_hash(p_device_id uuid)
returns text language sql stable set search_path = '' as $$
  select encode(extensions.hmac(p_device_id::text, s.salt, 'sha256'), 'hex')
    from private.settings s;
$$;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  lat         double precision not null,
  lng         double precision not null,
  level       smallint not null check (level between 1 and 3),
  category    text not null check (category in
                ('verkehr', 'baustelle', 'gastronomie', 'industrie', 'sonstiges')),
  comment     text check (comment is null or char_length(comment) <= 200),
  flag_count  integer not null default 0 check (flag_count >= 0),
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  constraint reports_in_bremen check (public.in_bremen_bbox(lat, lng))
);
create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_device_created_idx on public.reports (device_hash, created_at desc);

create table if not exists public.report_flags (
  report_id   uuid not null references public.reports (id) on delete cascade,
  device_hash text not null,
  created_at  timestamptz not null default now(),
  primary key (report_id, device_hash)
);
create index if not exists report_flags_device_created_idx on public.report_flags (device_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- Rechte: nur Lesen ausgewählter Spalten, nur sichtbare Meldungen
-- ---------------------------------------------------------------------------

alter table public.reports      enable row level security;
alter table public.report_flags enable row level security;

revoke all on public.reports      from anon, authenticated;
revoke all on public.report_flags from anon, authenticated;
grant select (id, created_at, lat, lng, level, category, comment, flag_count)
  on public.reports to anon, authenticated;

drop policy if exists reports_public_read on public.reports;
create policy reports_public_read on public.reports
  for select to anon, authenticated
  using (flag_count < 3 and created_at > now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- Meldung speichern
-- ---------------------------------------------------------------------------

create or replace function public.submit_report(
  p_lat       double precision,
  p_lng       double precision,
  p_level     smallint,
  p_category  text,
  p_comment   text,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash    text;
  v_comment text;
  v_id      uuid;
  v_created timestamptz;
begin
  if p_device_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_device');
  end if;
  if p_lat is null or p_lng is null or not public.in_bremen_bbox(p_lat, p_lng) then
    return jsonb_build_object('ok', false, 'error', 'outside_bremen');
  end if;
  if p_level is null or p_level not between 1 and 3 then
    return jsonb_build_object('ok', false, 'error', 'invalid_level');
  end if;
  if p_category is null or p_category not in
     ('verkehr', 'baustelle', 'gastronomie', 'industrie', 'sonstiges') then
    return jsonb_build_object('ok', false, 'error', 'invalid_category');
  end if;

  v_hash := private.device_hash(p_device_id);

  -- Parallele Anfragen desselben Geräts nacheinander abarbeiten.
  perform pg_advisory_xact_lock(hashtextextended(v_hash, 0));

  -- Notbremse gegen Bot-Fluten: höchstens 300 Meldungen pro Stunde insgesamt.
  if (select count(*) from public.reports where created_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;

  if (select count(*) from public.reports
       where device_hash = v_hash and created_at > now() - interval '24 hours') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_daily');
  end if;

  if exists (
    select 1 from public.reports r
     where r.device_hash = v_hash
       and r.created_at > now() - interval '30 minutes'
       and r.lat between p_lat - 0.01 and p_lat + 0.01
       and r.lng between p_lng - 0.02 and p_lng + 0.02
       and public.distance_m(r.lat, r.lng, p_lat, p_lng) < 100
  ) then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_nearby');
  end if;

  -- Aufräumen: Meldungen und Markierungen älter als 30 Tage löschen.
  -- (Ersetzt einen Cron-Job; unsichtbar sind sie durch die Policy ohnehin.)
  delete from public.reports where created_at < now() - interval '30 days';
  delete from public.report_flags where created_at < now() - interval '30 days';

  v_comment := public.sanitize_comment(p_comment);

  insert into public.reports (lat, lng, level, category, comment, device_hash)
  values (p_lat, p_lng, p_level, p_category, v_comment, v_hash)
  returning id, created_at into v_id, v_created;

  return jsonb_build_object('ok', true, 'report', jsonb_build_object(
    'id', v_id, 'created_at', v_created, 'lat', p_lat, 'lng', p_lng,
    'level', p_level, 'category', p_category, 'comment', v_comment, 'flag_count', 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- Meldung als Missbrauch markieren (ab 3 Markierungen ausgeblendet)
-- ---------------------------------------------------------------------------

create or replace function public.flag_report(
  p_report_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash       text;
  v_inserted   integer;
  v_flag_count integer;
begin
  if p_device_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_device');
  end if;
  v_hash := private.device_hash(p_device_id);
  perform pg_advisory_xact_lock(hashtextextended(v_hash, 1));

  if not exists (select 1 from public.reports where id = p_report_id) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if (select count(*) from public.report_flags
       where device_hash = v_hash and created_at > now() - interval '24 hours') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_daily');
  end if;

  insert into public.report_flags (report_id, device_hash)
  values (p_report_id, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'already_flagged', true);
  end if;

  update public.reports set flag_count = flag_count + 1
   where id = p_report_id
  returning flag_count into v_flag_count;

  return jsonb_build_object('ok', true, 'already_flagged', false, 'hidden', v_flag_count >= 3);
end;
$$;

-- Die beiden Funktionen darf nur die service_role aufrufen, also nur die
-- Edge Functions submit-report und flag-report, nachdem sie das Captcha
-- geprüft haben. Direkt aus dem Browser sind sie gesperrt.
revoke all on function public.submit_report(double precision, double precision, smallint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.flag_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.submit_report(double precision, double precision, smallint, text, text, uuid) to service_role;
grant execute on function public.flag_report(uuid, uuid) to service_role;

revoke all on function private.device_hash(uuid) from public, anon, authenticated;
