/** Collects explicit immutable plan terms for provider verification; publication remains a separate owner action. */
import type { CreateAppBillingPlanRequest } from "@elizaos/cloud-sdk/app-billing-admin";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { Textarea } from "../../../components/ui/textarea";
import type { CatalogIntent } from "./app-catalog-intent";

export function AppPlanForm({
  merchantId,
  clientRegistrationId,
  disabled,
  onSubmit,
}: {
  merchantId: string;
  clientRegistrationId: string;
  disabled: boolean;
  onSubmit: (intent: CatalogIntent) => void;
}) {
  const id = useId();
  const [adopt, setAdopt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = [
    ["name", "Plan name", "text", ""],
    ["family", "Product family key", "text", ""],
    ["key", "Plan key", "text", ""],
    ["amount", "Price per seat in USD cents", "number", ""],
    ["intervalCount", "Number of billing intervals", "number", "1"],
    ["minimum", "Minimum seats", "number", "1"],
    ["maximum", "Maximum seats", "number", "1"],
    ["trialAllowance", "Trial AI allowance (USD)", "text", "0.00"],
    ["allowance", "Paid period AI allowance (USD)", "text", "0.00"],
    ["completionsRpm", "Completion requests per minute", "number", "60"],
    ["embeddingsRpm", "Embedding requests per minute", "number", "60"],
    ["standardRpm", "Standard requests per minute", "number", "120"],
    ["strictRpm", "Strict requests per minute", "number", "30"],
  ] as const;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const form = new FormData(event.currentTarget);
        const text = (name: string) => String(form.get(name) ?? "").trim();
        const interval = text("interval");
        const expiredAccess = text("expired");
        if (
          !(
            interval === "day" ||
            interval === "week" ||
            interval === "month" ||
            interval === "year"
          ) ||
          !(expiredAccess === "read_only" || expiredAccess === "denied")
        ) {
          setError("Choose valid billing and expired access terms.");
          return;
        }
        const request: CreateAppBillingPlanRequest = {
          merchantId,
          clientRegistrationId,
          idempotencyKey: crypto.randomUUID(),
          name: text("name"),
          productFamilyKey: text("family"),
          planKey: text("key"),
          amountCents: Number(text("amount")),
          currency: "usd",
          interval,
          intervalCount: Number(text("intervalCount")),
          seats: {
            minimum: Number(text("minimum")),
            maximum: Number(text("maximum")),
          },
          trial: { days: 7, allowanceUsd: text("trialAllowance") },
          allowanceUsd: text("allowance"),
          featureKeys: text("features")
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
          expiredAccess,
          rateLimits: {
            completionsRpm: Number(text("completionsRpm")),
            embeddingsRpm: Number(text("embeddingsRpm")),
            standardRpm: Number(text("standardRpm")),
            strictRpm: Number(text("strictRpm")),
          },
        };
        if (request.seats.maximum < request.seats.minimum) {
          setError("Maximum seats must be at least the minimum.");
          return;
        }
        if (
          ![request.trial.allowanceUsd, request.allowanceUsd].every((v) =>
            /^\d+(\.\d{1,2})?$/.test(v),
          )
        ) {
          setError(
            "Enter nonnegative USD allowances with at most two decimal places.",
          );
          return;
        }
        onSubmit(
          adopt
            ? {
                kind: "adopt",
                request: {
                  ...request,
                  productReference: text("product"),
                  priceReference: text("price"),
                },
              }
            : { kind: "create", request },
        );
      }}
    >
      <h3 className="font-semibold">Add an immutable plan</h3>
      <p>
        Every plan includes a seven-day trial without a required payment method.
        Publishing makes this version available for new purchases. Existing
        subscriptions keep their current terms.
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={disabled} className="space-y-4">
        <label className="block" htmlFor={`${id}-mode`}>
          Plan source
        </label>
        <NativeSelect
          id={`${id}-mode`}
          value={adopt ? "adopt" : "create"}
          onChange={(event) => setAdopt(event.target.value === "adopt")}
        >
          <option value="create">Create provider product and price</option>
          <option value="adopt">
            Verify an existing provider product and price
          </option>
        </NativeSelect>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(([name, label, type, value]) => (
            <div key={name}>
              <label htmlFor={`${id}-${name}`}>{label}</label>
              <Input
                id={`${id}-${name}`}
                name={name}
                type={type}
                defaultValue={value}
                required
                min={name === "amount" ? 0 : 1}
                step={1}
              />
            </div>
          ))}
          <div>
            <label htmlFor={`${id}-interval`}>Billing interval</label>
            <NativeSelect
              id={`${id}-interval`}
              name="interval"
              defaultValue="month"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </NativeSelect>
          </div>
          <div>
            <label htmlFor={`${id}-expired`}>Access after expiration</label>
            <NativeSelect
              id={`${id}-expired`}
              name="expired"
              defaultValue="read_only"
            >
              <option value="read_only">Read only</option>
              <option value="denied">No access</option>
            </NativeSelect>
          </div>
        </div>
        <label className="block" htmlFor={`${id}-features`}>
          Feature keys, one per line
        </label>
        <Textarea id={`${id}-features`} name="features" />
        {adopt && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-product`}>
                Provider product reference
              </label>
              <Input id={`${id}-product`} name="product" required />
            </div>
            <div>
              <label htmlFor={`${id}-price`}>Provider price reference</label>
              <Input id={`${id}-price`} name="price" required />
            </div>
          </div>
        )}
        <Button size="touch" type="submit">
          {adopt ? "Verify existing price" : "Create plan draft"}
        </Button>
      </fieldset>
    </form>
  );
}
