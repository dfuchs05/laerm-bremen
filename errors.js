export class ApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
