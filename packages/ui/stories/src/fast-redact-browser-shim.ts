type FastRedactOptions = {
  paths?: string[];
  serialize?: false | ((value: unknown) => string);
};

type Redactor = ((value: unknown) => unknown) & {
  restore?: (value: unknown) => unknown;
};

const noopRedactor: Redactor = (value: unknown) => value;
noopRedactor.restore = (value: unknown) => value;

export default function fastRedact(
  _options: FastRedactOptions = {},
): Redactor {
  return noopRedactor;
}
