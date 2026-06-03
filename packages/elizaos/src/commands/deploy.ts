/**
 * `elizaos deploy` prints the Eliza Cloud deployment plan for the current
 * project. The CLI does not perform deployment side effects; the cloud
 * dashboard owns authenticated build, domain, and Vercel orchestration.
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
  console.log(pc.bold(pc.cyan("elizaos deploy — deployment plan")));
  console.log(
    pc.dim("No network calls, filesystem writes, or builds are performed."),
  );
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
      "Use the Eliza Cloud dashboard to run this plan once the project and domain settings are ready.",
    ),
  );
  console.log();
}

export function runDeploy(options: DeployOptions): number {
  if (options.domain && !DOMAIN_REGEX.test(options.domain)) {
    console.error(
      pc.red(
        `Invalid --domain "${options.domain}". Expected a valid hostname (e.g. app.example.com).`,
      ),
    );
    return 1;
  }

  const cwd = process.cwd();
  const plan = buildPlan(options, cwd);

  if (options.verbose) {
    console.error(pc.dim(`[deploy] cwd=${cwd}`));
    console.error(pc.dim(`[deploy] options=${JSON.stringify(options)}`));
  }

  printPlan(plan);
  return 0;
}

export function deploy(options: DeployOptions): void {
  process.exit(runDeploy(options));
}
