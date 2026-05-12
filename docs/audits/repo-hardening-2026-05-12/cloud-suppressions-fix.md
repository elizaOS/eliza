# Cloud Stripe/payment-request suppressions fix

Date: 2026-05-12

## Scope

Owned files:

- `cloud/packages/lib/stripe.ts`
- `cloud/packages/tests/unit/payment-requests-service.test.ts`
- `cloud/packages/tests/integration/db/message-router-service.test.ts`
- `cloud/packages/tests/unit/oauth/secrets-adapter-utils.test.ts`

## Suppressions removed

- Removed the Stripe `@ts-expect-error` around the pinned API version. The pin is now checked against Stripe's generated `WebhookEndpointCreateParams.ApiVersion` union before being adapted to the constructor config type.
- Removed the unsupported payment provider `@ts-expect-error` in `payment-requests-service.test.ts`. The test now routes the deliberately invalid payload through a typed invalid-input helper.
- Removed the missing `specific_payer.payerIdentityId` `@ts-expect-error` in `payment-requests-service.test.ts`. The negative runtime assertion is unchanged.
- Removed the unknown message provider `@ts-expect-error` in `message-router-service.test.ts`. The test now uses a typed invalid-input helper for the intentionally invalid send payload.
- Removed the generated ID override `@ts-expect-error` in `secrets-adapter-utils.test.ts`. The runtime tamper-resistance case is preserved through a typed invalid-overrides helper.

## Suppressions kept

None in the owned slice.

## Validation

Commands run and status:

- Pass: `./cloud/node_modules/.bin/biome check --write cloud/packages/lib/stripe.ts cloud/packages/tests/unit/payment-requests-service.test.ts cloud/packages/tests/integration/db/message-router-service.test.ts cloud/packages/tests/unit/oauth/secrets-adapter-utils.test.ts`
- Pass: `./cloud/node_modules/.bin/biome check cloud/packages/lib/stripe.ts cloud/packages/tests/unit/payment-requests-service.test.ts cloud/packages/tests/integration/db/message-router-service.test.ts cloud/packages/tests/unit/oauth/secrets-adapter-utils.test.ts`
- Pass: `~/.bun/bin/bun run --cwd packages/lib typecheck`
- Pass: `~/.bun/bin/bun ./node_modules/typescript/lib/tsc.js --noEmit --project tsconfig.test.json`
- Pass: `SKIP_DB_DEPENDENT=1 SKIP_SERVER_CHECK=true ~/.bun/bin/bun test --preload ./packages/tests/load-env.ts packages/tests/unit/payment-requests-service.test.ts packages/tests/unit/oauth/secrets-adapter-utils.test.ts packages/tests/integration/db/message-router-service.test.ts` (`47 pass`, `38 skip`, `0 fail`)
