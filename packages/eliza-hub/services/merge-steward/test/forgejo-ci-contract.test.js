import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const WORKFLOW_PATH = new URL(
  "../../../.forgejo/workflows/merge-steward.yml",
  import.meta.url,
);

describe("Forgejo CI contract", () => {
  it("runs for every push and pull request instead of path-limited deployment changes", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    assert.match(workflow, /^\s*push:\s*$/m);
    assert.match(workflow, /^\s*pull_request:\s*$/m);
    assert.doesNotMatch(workflow, /^\s*paths:\s*$/m);
  });

  it("gates steward tests, dependency audit, staging scripts, compose, and runner isolation", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");

    assert.match(workflow, /npm ci/);
    assert.match(workflow, /npm run check/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm audit --omit=dev/);
    assert.match(workflow, /image: node:24-alpine3\.23/);
    assert.match(workflow, /apk add --no-cache .*actionlint/);
    assert.match(workflow, /apk add --no-cache .*opentofu/);
    assert.match(
      workflow,
      /actionlint -config-file \.github\/actionlint\.yaml \.forgejo\/workflows\/\*\.yml/,
    );
    assert.match(workflow, /apk add --no-cache .*ripgrep/);
    assert.match(workflow, /scripts\/private-reference-scan\.sh/);
    assert.match(
      workflow,
      /docker build -f services\/merge-steward\/Dockerfile -t eliza\/merge-steward:ci \./,
    );
    assert.match(workflow, /apk add --no-cache .*prometheus/);
    assert.match(workflow, /apk add --no-cache .*shellcheck/);
    assert.match(
      workflow,
      /bash -n deployment\/hetzner-staging\/scripts\/\*\.sh/,
    );
    assert.match(
      workflow,
      /shellcheck deployment\/hetzner-staging\/scripts\/\*\.sh scripts\/\*\.sh/,
    );
    assert.match(
      workflow,
      /deployment\/hetzner-staging\/scripts\/validate-infrastructure\.sh/,
    );
    assert.match(
      workflow,
      /promtool check config --syntax-only prometheus\.yml/,
    );
    assert.match(workflow, /promtool check rules merge-steward-alerts\.yml/);
    assert.match(
      workflow,
      /docker compose -f deployment\/hetzner-staging\/compose\.yml --profile steward config/,
    );
    assert.match(
      workflow,
      /compose\.actions-runner\.yml --profile steward --profile actions-runner config/,
    );
    assert.match(workflow, /\/var\/run\/docker\.sock/);
    assert.match(
      workflow,
      /deployment\/hetzner-staging\/scripts\/release-gate\.sh/,
    );
    assert.match(workflow, /RUN_TESTS=false/);
    assert.match(workflow, /VALIDATE_RUNNER=true/);
    assert.match(workflow, /FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION=true/);
    assert.match(workflow, /FORGEJO_OIDC_REQUIRED_CLAIM_NAME=tenant/);
    assert.match(workflow, /FORGEJO_DEFAULT_THEME=eliza/);
    assert.match(workflow, /MERGE_STEWARD_OIDC_REQUIRED_GROUPS=eliza-team/);
  });
});
