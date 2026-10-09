/** Host errors intentionally omit provider bodies and protected values. */
export class BillHostError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BillHostError";
    this.code = "BILL_HOST_ERROR";
  }
}
