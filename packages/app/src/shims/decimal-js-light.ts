type DecimalInput = Decimal | number | string;

export default class Decimal {
  private readonly value: number;

  constructor(value: DecimalInput) {
    this.value = value instanceof Decimal ? value.value : Number(value);
  }

  abs(): Decimal {
    return new Decimal(Math.abs(this.value));
  }

  add(value: DecimalInput): Decimal {
    return new Decimal(this.value + Number(new Decimal(value)));
  }

  sub(value: DecimalInput): Decimal {
    return new Decimal(this.value - Number(new Decimal(value)));
  }

  div(value: DecimalInput): Decimal {
    return new Decimal(this.value / Number(new Decimal(value)));
  }

  mul(value: DecimalInput): Decimal {
    return new Decimal(this.value * Number(new Decimal(value)));
  }

  mod(value: DecimalInput): Decimal {
    return new Decimal(this.value % Number(new Decimal(value)));
  }

  pow(value: DecimalInput): Decimal {
    return new Decimal(this.value ** Number(new Decimal(value)));
  }

  log(base?: DecimalInput): Decimal {
    const naturalLog = Math.log(this.value);
    return new Decimal(
      base === undefined
        ? naturalLog
        : naturalLog / Math.log(Number(new Decimal(base))),
    );
  }

  lt(value: DecimalInput): boolean {
    return this.value < Number(new Decimal(value));
  }

  lte(value: DecimalInput): boolean {
    return this.value <= Number(new Decimal(value));
  }

  isint(): boolean {
    return Number.isInteger(this.value);
  }

  toNumber(): number {
    return this.value;
  }

  valueOf(): number {
    return this.value;
  }

  toString(): string {
    return String(this.value);
  }
}
