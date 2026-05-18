/**
 * `elizaos deploy` — keel only.
 *
 * @experimental
 * This command currently registers the flag surface and prints the planned
 * deploy sequence in --dry-run mode. The real Vercel + custom-domain pipeline
 * lands in a follow-up PR. See DEPLOY_DESIGN.md.
 */

import pc from "picocolors";
import type { DeployOptions } from "../types.js";

const DOMAIN_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

interface PlannedStep {
  label: string;
  detail: string;
  skipped?: boolean;
}

function buildPlan(options: DeployOptions, cwd: string): PlannedStep[] {
  const appId = options.appId ?? "<resolved from .elizaos/template.json>";
  const domain = options.domain;
  return [
    {
      label: "auth check",
      detail: "Load credentials, GET /api/v1/me, abort on 401.",
    },
    {
      label: "app lookup",
      detail: `Resolve app-id (${appId}).`,
    },
    {
      label: "build",
      detail: `Run 'bun run build' in ${cwd}.`,
    },
    {
      label: "upload",
      detail: "Push built artifact to the app's linked GitHub repo.",
    },
    {
      label: "register app deploy",
      detail: `POST /api/v1/apps/${appId}/deploy → status=building.`,
    },
    {
      label: "attach domain",
      detail: domain
        ? `POST /api/v1/apps/${appId}/domains { domain: "${domain}" } and surface DNS TXT record.`
        : "(no --domain provided — using default apps.elizacloud.ai subdomain).",
      skipped: !domain,
    },
    {
      label: "poll status",
      detail: `GET /api/v1/apps/${appId}/deploy/status every 5s until deployed|failed (10min cap).`,
    },
    {
      label: "print URL",
      detail: domain
        ? `URL: https://${domain}  (+ apps.elizacloud.ai subdomain).`
        : "URL: https://<subdomain>.apps.elizacloud.ai",
    },
  ];
}

function printPlan(plan: PlannedStep[]): void {
  console.log();
  console.log(pc.bold(pc.cyan("elizaos deploy — dry run")));
  console.log(pc.dim("Planned sequence (no network calls performed):"));
  console.log();
  plan.forEach((step, index) => {
    const num = pc.dim(`${(index + 1).toString().padStart(2, " ")}.`);
    const label = step.skipped
      ? pc.dim(pc.strikethrough(step.label))
      : pc.bold(step.label);
    console.log(`  ${num} ${label}`);
    console.log(`      ${pc.dim(step.detail)}`);
  });
  console.log();
  console.log(
    pc.dim(
      "See https://github.com/elizaOS/eliza/blob/develop/packages/elizaos/src/commands/DEPLOY_DESIGN.md for the full design.",
    ),
  );
  console.log();
}

export function deploy(options: DeployOptions): void {
  if (options.domain && !DOMAIN_REGEX.test(options.domain)) {
    console.error(
      pc.red(
        `Invalid --domain "${options.domain}". Expected a valid hostname (e.g. app.example.com).`,
      ),
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const plan = buildPlan(options, cwd);

  if (options.verbose) {
    console.error(pc.dim(`[deploy] cwd=${cwd}`));
    console.error(pc.dim(`[deploy] options=${JSON.stringify(options)}`));
  }

  if (options.dryRun) {
    printPlan(plan);
    process.exit(0);
  }

  console.error(
    pc.yellow(
      "Real deploy not yet implemented — see https://github.com/elizaOS/eliza/blob/develop/packages/elizaos/src/commands/DEPLOY_DESIGN.md. Pass --dry-run to preview.",
    ),
  );
  process.exit(1);
}
