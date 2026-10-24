-- =============================================================================
-- Umstellung auf Captcha: sperrt die Melde-Funktionen für den Browser.
--
-- ERST AUSFÜHREN, wenn die Edge Functions laufen und die neue Website
-- hochgeladen ist (siehe README, Schritt 5). Vorher würde die alte Seite
-- sofort nicht mehr melden können.
--
-- Rückgängig machen (zurück zur Version ohne Captcha): die zwei auskommentierten Zeilen ganz
-- unten in dieser Datei ausführen.
-- =============================================================================

revoke all on function public.submit_report(double precision, double precision, smallint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.flag_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.submit_report(double precision, double precision, smallint, text, text, uuid) to service_role;
grant execute on function public.flag_report(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Nur zum Zurückstellen (normalerweise NICHT ausführen):
-- grant execute on function public.submit_report(double precision, double precision, smallint, text, text, uuid) to anon, authenticated;
-- grant execute on function public.flag_report(uuid, uuid) to anon, authenticated;
