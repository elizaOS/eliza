/**
 * Browser shim for fast-redact so the stories app can bundle a redaction call without the Node build.
 */
type FastRedactOptions = {
  paths?: string[];
  serialize?: false | ((value: unknown) => string);
};

type Redactor = ((value: unknown) => unknown) & {
  restore?: (value: unknown) => unknown;
};

const noopRedactor: Redactor = (value: unknown) => value;
noopRedactor.restore = (value: unknown) => value;

export default function fastRedact(_options: FastRedactOptions = {}): Redactor {
  return noopRedactor;
}
