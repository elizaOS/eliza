/** Pins how STEWARD_GOOGLE_NATIVE_CLIENT_IDS absence is told apart from corruption. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { googleNativeClientIds } from "../auth/google-native";

const ENV_KEY = "STEWARD_GOOGLE_NATIVE_CLIENT_IDS";
const saved = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

test("returns no ids when the mapping is not configured at all", () => {
  expect(googleNativeClientIds("app_client")).toEqual([]);
});

test("returns the allowlisted audiences for a bound app client", () => {
  process.env[ENV_KEY] = JSON.stringify({
    app_client: [
      "123-abc.apps.googleusercontent.com",
      "not-an-audience",
      42,
      "456-def.apps.googleusercontent.com",
    ],
  });

  expect(googleNativeClientIds("app_client")).toEqual([
    "123-abc.apps.googleusercontent.com",
    "456-def.apps.googleusercontent.com",
  ]);
});

test("returns no ids when the map is readable but this client is not bound", () => {
  process.env[ENV_KEY] = JSON.stringify({
    other_client: ["123-abc.apps.googleusercontent.com"],
  });

  expect(googleNativeClientIds("app_client")).toEqual([]);
});

test("reports an unparseable mapping instead of looking unconfigured", () => {
  process.env[ENV_KEY] =
    '{"app_client": ["123-abc.apps.googleusercontent.com",]}';

  expect(() => googleNativeClientIds("app_client")).toThrow(
    /STEWARD_GOOGLE_NATIVE_CLIENT_IDS/,
  );
});

test("reports a non-object mapping instead of looking unconfigured", () => {
  process.env[ENV_KEY] = '["123-abc.apps.googleusercontent.com"]';

  expect(() => googleNativeClientIds("app_client")).toThrow(
    /STEWARD_GOOGLE_NATIVE_CLIENT_IDS/,
  );
});

test("reports a non-array entry instead of looking unbound", () => {
  process.env[ENV_KEY] = JSON.stringify({
    app_client: "123-abc.apps.googleusercontent.com",
  });

  expect(() => googleNativeClientIds("app_client")).toThrow(
    /STEWARD_GOOGLE_NATIVE_CLIENT_IDS/,
  );
});
