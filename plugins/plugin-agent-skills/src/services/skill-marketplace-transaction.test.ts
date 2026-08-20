/**
 * Adversarial transaction tests for repository-backed marketplace installs.
 * The git child is deterministic and abort-aware while filesystem publication
 * uses real temporary workspace and state directories.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  installMarketplaceSkill,
  listInstalledMarketplaceSkills,
  uninstallMarketplaceSkill,
} from "./skill-marketplace";

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  execFileMock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("marketplace repository install transaction", () => {
  it("fails closed with a typed error for corrupt install records", async () => {
    const workspaceDir = await temporaryDirectory("marketplace-workspace-");
    const recordPath = path.join(
      workspaceDir,
      "skills",
      ".cache",
      "marketplace-installs.json",
    );
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(recordPath, "not-json", "utf-8");

    await expect(listInstalledMarketplaceSkills(workspaceDir)).rejects.toMatchObject({
      code: "SKILL_MARKETPLACE_RECORDS_INVALID",
      context: { workspaceDir },
    });
  });

  it("kills an in-flight git operation and publishes neither directory nor record", async () => {
    const workspaceDir = await temporaryDirectory("marketplace-workspace-");
    await fs.mkdir(resolveStateDir(), { recursive: true });
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { signal?: AbortSignal },
        callback: (error: Error) => void,
      ) => {
        childSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("git operation aborted");
            error.name = "AbortError";
            callback(error);
          },
          { once: true },
        );
        return {};
      },
    );

    const install = installMarketplaceSkill(
      workspaceDir,
      {
        repository: "owner/repository",
        path: "skills/example",
        name: "cancelled-skill",
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce());
    controller.abort(new Error("client disconnected"));

    await expect(install).rejects.toMatchObject({
      code: "SKILL_DOWNLOAD_ABORTED",
    });
    expect(childSignal).toBe(controller.signal);
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "skills",
          ".marketplace",
          "cancelled-skill",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(
        path.join(
          workspaceDir,
          "skills",
          ".cache",
          "marketplace-installs.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges concurrent different-id installs into the latest records file", async () => {
    const workspaceDir = await temporaryDirectory("marketplace-workspace-");
    await fs.mkdir(resolveStateDir(), { recursive: true });
    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: { signal?: AbortSignal },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args[0] === "clone") {
          const cloneDir = args.at(-1);
          if (!cloneDir) throw new Error("clone target missing");
          void fs
            .mkdir(path.join(cloneDir, "skills", "example"), {
              recursive: true,
            })
            .then(() =>
              fs.writeFile(
                path.join(cloneDir, "skills", "example", "SKILL.md"),
                "---\nname: Example\ndescription: Safe example\n---\n\n# Example\n",
                "utf-8",
              ),
            )
            .then(() => callback(null, "", ""), callback);
          return {};
        }
        callback(null, "", "");
        return {};
      },
    );

    await expect(
      Promise.all([
        installMarketplaceSkill(workspaceDir, {
          repository: "owner/one",
          path: "skills/example",
          name: "first-skill",
        }),
        installMarketplaceSkill(workspaceDir, {
          repository: "owner/two",
          path: "skills/example",
          name: "second-skill",
        }),
      ]),
    ).resolves.toHaveLength(2);

    expect(
      (await listInstalledMarketplaceSkills(workspaceDir)).map(({ id }) => id).sort(),
    ).toEqual(["first-skill", "second-skill"]);
  });

  it("serializes a same-id uninstall behind an in-flight install", async () => {
    const workspaceDir = await temporaryDirectory("marketplace-workspace-");
    await fs.mkdir(resolveStateDir(), { recursive: true });
    let finishClone: (() => Promise<void>) | undefined;
    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: { signal?: AbortSignal },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args[0] === "clone") {
          const cloneDir = args.at(-1);
          if (!cloneDir) throw new Error("clone target missing");
          finishClone = async () => {
            await fs.mkdir(path.join(cloneDir, "skills", "example"), {
              recursive: true,
            });
            await fs.writeFile(
              path.join(cloneDir, "skills", "example", "SKILL.md"),
              "---\nname: Example\ndescription: Safe example\n---\n\n# Example\n",
              "utf-8",
            );
            callback(null, "", "");
          };
          return {};
        }
        callback(null, "", "");
        return {};
      },
    );

    const install = installMarketplaceSkill(workspaceDir, {
      repository: "owner/repository",
      path: "skills/example",
      name: "serialized-skill",
    });
    await vi.waitFor(() => expect(finishClone).toBeTypeOf("function"));
    const uninstall = uninstallMarketplaceSkill(workspaceDir, "serialized-skill");
    let uninstallSettled = false;
    void uninstall.then(
      () => {
        uninstallSettled = true;
      },
      () => {
        uninstallSettled = true;
      },
    );
    await Promise.resolve();
    expect(uninstallSettled).toBe(false);
    await finishClone?.();

    await expect(install).resolves.toMatchObject({ id: "serialized-skill" });
    await expect(uninstall).resolves.toMatchObject({ id: "serialized-skill" });
    await expect(listInstalledMarketplaceSkills(workspaceDir)).resolves.toEqual(
      [],
    );
  });
});
