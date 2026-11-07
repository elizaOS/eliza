import { expect, test } from "vitest";
import { speechHttpTimings } from "./speech-http-timing";

test("keeps only known numeric durations without arbitrary header descriptions", () => {
  const x = speechHttpTimings(
    new Headers({
      "server-timing":
        'entry_dispatch;dur=4000.1;desc="PRIVATE", cloud_worker;dur=3900, auth;dur=500, inference_module_init;dur=10',
      "x-secret": "PRIVATE",
    }),
  );
  expect(x).toEqual({
    entry_dispatch: 4000.1,
    cloud_worker: 3900,
    inference_module_init: 10,
  });
  expect(JSON.stringify(x)).not.toContain("PRIVATE");
});
test("ambiguous duplicates/nonfinite/negative/oversized values rejected", () => {
  expect(
    speechHttpTimings(
      new Headers({
        "server-timing":
          "entry_dispatch;dur=2,entry_dispatch;dur=3,cloud_worker;dur=NaN,inference_module_init;dur=-2",
      }),
    ),
  ).toEqual({});
  expect(
    speechHttpTimings(
      new Headers({ "server-timing": "cloud_worker;dur=60001" }),
    ),
  ).toEqual({});
  expect(
    speechHttpTimings(new Headers({ "server-timing": "a".repeat(4097) })),
  ).toEqual({});
});

test("unavailable timing headers cannot alter transport", () => {
  expect(
    speechHttpTimings({
      get() {
        throw new Error("private");
      },
    } as unknown as Headers),
  ).toEqual({});
});

test("retains all exact numeric bootstrap phases from consent and mint without descriptions", () => {
  const expected = {
    speech_infrastructure: 1,
    speech_body: 2,
    speech_identity_rate: 3,
    speech_standing: 4,
    speech_consent_write: 5,
    speech_credential_validation: 6,
    speech_consent_consume: 7,
    speech_key_import: 8,
    speech_signing: 9,
    speech_post_sign_validation: 10,
    speech_directory_write: 11,
  };
  const header = Object.entries(expected)
    .map(([name, value]) => `${name};dur=${value};desc="PRIVATE_TOKEN_NONCE"`)
    .join(", ");
  const parsed = speechHttpTimings(
    new Headers({
      "server-timing":
        header +
        ", cloud_worker;dur=50, speech_account;dur=999, speech_nonce;dur=1",
    }),
  );
  expect(parsed).toEqual({ ...expected, cloud_worker: 50 });
  expect(Object.keys(parsed).length).toBe(12);
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
});
test("bootstrap fields retain duplicate, value, size and field-count refusal boundaries", () => {
  const parsed = speechHttpTimings(
    new Headers({
      "server-timing":
        "speech_signing;dur=1,speech_signing;dur=2,speech_signing;dur=3,speech_body;dur=NaN,speech_standing;dur=-1,speech_key_import;dur=60001,speech_identity_rate;dur=Infinity,speech_directory_write;dur=60000,speech_consent_write;dur=0",
    }),
  );
  expect(parsed).toEqual({
    speech_directory_write: 60000,
    speech_consent_write: 0,
  });
  expect(
    speechHttpTimings(
      new Headers({
        "server-timing":
          Array(32).fill("unknown;dur=1").join(",") + ",speech_signing;dur=1",
      }),
    ),
  ).toEqual({});
  expect(
    speechHttpTimings(
      new Headers({
        "server-timing": "speech_signing;dur=" + "1".repeat(4096),
      }),
    ),
  ).toEqual({});
});
