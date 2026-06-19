type FastRedactOptions = {
  paths?: string[];
  serialize?: false | ((value: unknown) => string);
};

type Redactor = ((value: unknown) => unknown) & {
  restore?: (value: unknown) => unknown;
};

const noopRedactor: Redactor = (value: unknown) => value;
noopRedactor.restore = (value: unknown) => value;

export default function fastRedact(options: FastRedactOptions = {}): Redactor {
  if (!options.paths?.length) {
    return noopRedactor;
  }

  return noopRedactor;
}
