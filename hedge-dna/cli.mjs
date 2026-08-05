#!/usr/bin/env node
/**
 * CLI for the hedge-dna agent bundle: validate, wake, show DNA files,
 * inspect persona modes, export the eliZERO-style eliza character, and
 * print continuity paths for OpenClawd / clawdbot workspaces.
 *
 * Usage:
 *   hedge-dna <command> [args]
 *   node cli.mjs <command> [args]
 *   npm run hedge-dna -- <command>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleDirectory, validateBundle } from "./validate.mjs";

const DNA_FILES = {
  identity: "IDENTITY.md",
  soul: "SOUL.md",
  tools: "TOOLS.md",
  user: "USER.md",
};

const COMMANDS = [
  "help",
  "validate",
  "wake",
  "show",
  "identity",
  "soul",
  "tools",
  "user",
  "persona",
  "character",
  "eliza",
  "clawd",
  "modes",
  "mode",
  "paths",
  "greeting",
];

function usage(exitCode = 0) {
  const text = `hedge-dna — eliZERO-class Clawd hedge + DNA continuity CLI

Usage:
  hedge-dna <command> [options]

Commands:
  validate              Validate persona + DNA + character + clawd-power
  wake                  Session wake: greeting + identity + mode stack
  show <file>           Print a DNA file: identity|soul|tools|user
  identity              Print IDENTITY.md
  soul                  Print SOUL.md
  tools                 Print TOOLS.md
  user                  Print USER.md
  persona               Print hedgedna.json summary (or --json full)
  character | eliza     Print eliza character.json (eliZERO shape)
  clawd                 Print clawd-power.json ($CLAWD mint, Zero, laws)
  modes                 List molt modes
  mode <name>           Show one mode (value|moat|lattice|activist|builder)
  greeting              Print persona greeting
  paths                 Print absolute continuity file paths
  help                  This help

Options:
  --json                Machine-readable JSON where supported
  --root <dir>          Bundle root (default: this package)

Examples:
  hedge-dna validate
  hedge-dna wake
  hedge-dna character --json
  hedge-dna clawd
  hedge-dna mode lattice
  hedge-dna show soul
  hedge-dna persona --json
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = { json: false, root: bundleDirectory };
  const positional = [];

  while (args.length > 0) {
    const a = args.shift();
    if (a === "--json") {
      flags.json = true;
    } else if (a === "--root") {
      const next = args.shift();
      if (!next) {
        throw new Error("--root requires a directory path");
      }
      flags.root = resolve(next);
    } else if (a === "-h" || a === "--help") {
      positional.unshift("help");
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  return { flags, positional };
}

async function readJson(root, name) {
  return JSON.parse(await readFile(resolve(root, name), "utf8"));
}

async function readText(root, name) {
  return readFile(resolve(root, name), "utf8");
}

async function cmdValidate(flags) {
  const result = await validateBundle({ root: flags.root, quiet: flags.json });
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  }
  return 0;
}

async function cmdWake(flags) {
  const result = await validateBundle({ root: flags.root, quiet: true });
  const personaDoc = await readJson(flags.root, "hedgedna.json");
  const clawdPower = await readJson(flags.root, "clawd-power.json");
  const identity = await readText(flags.root, "IDENTITY.md");
  const payload = {
    ok: true,
    greeting: personaDoc.persona?.greeting ?? "",
    name: result.personaName,
    character: result.characterName,
    clawdMint: result.clawdMint,
    clawdSymbol: clawdPower.token?.symbol ?? clawdPower.symbol ?? "CLAWD",
    zero: clawdPower.zero ?? {},
    sibling: clawdPower.sibling ?? "eliZERO",
    birth: {
      clawd: clawdPower.birthFunding?.clawdAmount,
      sol: clawdPower.birthFunding?.solAmount,
    },
    modes: result.modes,
    defaultStack: ["value", "lattice", "moat"],
    continuity: personaDoc.continuity ?? {},
    signature: "Margin of safety first. Invert before you ape. Proof beats promises.",
    identityPreview: identity.split("\n").slice(0, 14).join("\n"),
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  console.log(payload.greeting);
  console.log("");
  console.log(`Name: ${payload.name} · sibling of eliZERO`);
  console.log(`Clawd: $${payload.clawdSymbol} ${payload.clawdMint}`);
  console.log(`Zero: ${payload.zero.loop ?? "flat-fifo"} · ${(payload.zero.invariants ?? []).join(", ")}`);
  console.log(`Modes: ${payload.modes.join(", ")}`);
  console.log(`Default stack: ${payload.defaultStack.join(" → ")}`);
  console.log(`Signature: ${payload.signature}`);
  console.log("");
  console.log("--- IDENTITY (preview) ---");
  console.log(payload.identityPreview);
  console.log("");
  console.log("Read SOUL.md + USER.md + TOOLS.md + clawd-power.json before acting.");
  console.log("Molt modes; don't juggle mascots. Flat loop. Proof or cope.");
  return 0;
}

async function cmdCharacter(flags) {
  const character = await readJson(flags.root, "character.json");
  if (flags.json) {
    console.log(JSON.stringify(character, null, 2));
    return 0;
  }
  console.log(`${character.name} (@${character.username ?? "?"})`);
  console.log(`Provider: ${character.modelProvider ?? "?"} · x402: ${character.x402Support === true}`);
  console.log(`Clawd mint: ${character.settings?.clawd?.mint ?? "?"}`);
  console.log(`Zero: ${character.settings?.zero?.loop ?? "?"} · ${character.settings?.zero?.engine ?? "?"}`);
  console.log(`Sibling: ${character.eliza?.sibling ?? "eliZERO"}`);
  console.log(`Modes: ${(character.settings?.hedge?.defaultStack ?? []).join(" → ")}`);
  console.log("");
  console.log(character.system ?? "");
  return 0;
}

async function cmdClawd(flags) {
  const clawdPower = await readJson(flags.root, "clawd-power.json");
  if (flags.json) {
    console.log(JSON.stringify(clawdPower, null, 2));
    return 0;
  }
  const symbol = clawdPower.token?.symbol ?? clawdPower.symbol ?? "CLAWD";
  const mint = clawdPower.token?.mint ?? clawdPower.mint ?? "?";
  const clawdAmt = clawdPower.birthFunding?.clawdAmount ?? clawdPower.birthFunding?.clawd ?? "?";
  const solAmt = clawdPower.birthFunding?.solAmount ?? clawdPower.birthFunding?.sol ?? "?";
  const loop = clawdPower.payments?.economicLoop ?? clawdPower.loop ?? "";
  console.log(`$${symbol} ${mint}`);
  console.log(`Agent: ${clawdPower.agent ?? "?"} · poweredBy: ${clawdPower.poweredBy ?? "?"} · required: ${clawdPower.required === true}`);
  console.log(`Sibling: ${clawdPower.sibling ?? "eliZERO"}`);
  console.log(`Payment: ${clawdPower.payments?.protocol ?? "x402"} · gateway: ${clawdPower.payments?.gateway ?? ""}`);
  console.log(`Birth: ${clawdAmt} CLAWD + ${solAmt} SOL`);
  console.log(`Loop: ${loop}`);
  console.log(`Zero: ${clawdPower.zero?.loop ?? "flat-fifo"} · ${(clawdPower.zero?.invariants ?? []).join(", ")}`);
  console.log("Laws:");
  for (const [k, v] of Object.entries(clawdPower.laws ?? {})) {
    console.log(`  ${k}. ${v}`);
  }
  return 0;
}

async function cmdShow(flags, which) {
  const key = which?.toLowerCase();
  const file = DNA_FILES[key];
  if (!file) {
    console.error(`unknown DNA file: ${which ?? "(missing)"}`);
    console.error(`expected one of: ${Object.keys(DNA_FILES).join(", ")}`);
    return 1;
  }
  const body = await readText(flags.root, file);
  if (flags.json) {
    console.log(JSON.stringify({ file, path: resolve(flags.root, file), body }, null, 2));
  } else {
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  }
  return 0;
}

async function cmdPersona(flags) {
  const personaDoc = await readJson(flags.root, "hedgedna.json");
  if (flags.json) {
    console.log(JSON.stringify(personaDoc, null, 2));
    return 0;
  }

  const p = personaDoc.persona ?? {};
  console.log(`${p.avatar ?? "🦞🧬"} ${p.name ?? "?"} — ${p.role ?? ""}`);
  console.log(p.greeting ?? "");
  console.log("");
  console.log(`Quote: ${p.core_quote ?? ""}`);
  console.log(`Traits: ${(p.traits ?? []).join(", ")}`);
  console.log(`Modes: ${Object.keys(personaDoc.modes ?? {}).join(", ")}`);
  console.log(`Lineage: ${Object.keys(personaDoc.lineage ?? {}).join(", ")}`);
  return 0;
}

async function cmdModes(flags) {
  const personaDoc = await readJson(flags.root, "hedgedna.json");
  const modes = personaDoc.modes ?? {};
  if (flags.json) {
    console.log(JSON.stringify(modes, null, 2));
    return 0;
  }
  for (const [name, meta] of Object.entries(modes)) {
    console.log(`${name.padEnd(10)} ← ${meta.source ?? "?"} · ${meta.when ?? ""}`);
  }
  return 0;
}

async function cmdMode(flags, name) {
  if (!name) {
    console.error("mode requires a name: value|moat|lattice|activist|builder");
    return 1;
  }
  const personaDoc = await readJson(flags.root, "hedgedna.json");
  const mode = personaDoc.modes?.[name];
  if (!mode) {
    console.error(`unknown mode: ${name}`);
    console.error(`available: ${Object.keys(personaDoc.modes ?? {}).join(", ")}`);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify({ name, ...mode }, null, 2));
    return 0;
  }
  console.log(`Mode: ${name}`);
  console.log(`Source: ${mode.source ?? ""}`);
  console.log(`When: ${mode.when ?? ""}`);
  console.log(`Tone: ${(mode.tone ?? []).join(", ")}`);
  console.log("Phrases:");
  for (const phrase of mode.phrases ?? []) {
    console.log(`  · ${phrase}`);
  }
  return 0;
}

async function cmdPaths(flags) {
  const paths = {
    root: flags.root,
    package: resolve(flags.root, "package.json"),
    index: resolve(flags.root, "index.json"),
    persona: resolve(flags.root, "hedgedna.json"),
    character: resolve(flags.root, "character.json"),
    characterSeed: resolve(flags.root, "character.seed.json"),
    catalog: resolve(flags.root, "manifest.json"),
    clawdPower: resolve(flags.root, "clawd-power.json"),
    identity: resolve(flags.root, "IDENTITY.md"),
    soul: resolve(flags.root, "SOUL.md"),
    tools: resolve(flags.root, "TOOLS.md"),
    user: resolve(flags.root, "USER.md"),
    bootstrap: resolve(flags.root, "BOOTSTRAP.md.COMPLETED"),
    validate: resolve(flags.root, "validate.mjs"),
    cli: resolve(flags.root, "cli.mjs"),
  };
  if (flags.json) {
    console.log(JSON.stringify(paths, null, 2));
  } else {
    for (const [k, v] of Object.entries(paths)) {
      console.log(`${k.padEnd(10)} ${v}`);
    }
  }
  return 0;
}

async function cmdGreeting(flags) {
  const personaDoc = await readJson(flags.root, "hedgedna.json");
  const greeting = personaDoc.persona?.greeting ?? "";
  if (flags.json) {
    console.log(JSON.stringify({ greeting }, null, 2));
  } else {
    console.log(greeting);
  }
  return 0;
}

async function main(argv) {
  let flags;
  let positional;
  try {
    ({ flags, positional } = parseArgs(argv));
  } catch (err) {
    console.error(String(err?.message ?? err));
    return 1;
  }

  const command = (positional[0] ?? "help").toLowerCase();
  const rest = positional.slice(1);

  try {
    switch (command) {
      case "help":
        usage(0);
        return 0;
      case "validate":
        return await cmdValidate(flags);
      case "wake":
        return await cmdWake(flags);
      case "show":
        return await cmdShow(flags, rest[0]);
      case "identity":
        return await cmdShow(flags, "identity");
      case "soul":
        return await cmdShow(flags, "soul");
      case "tools":
        return await cmdShow(flags, "tools");
      case "user":
        return await cmdShow(flags, "user");
      case "persona":
        return await cmdPersona(flags);
      case "character":
      case "eliza":
        return await cmdCharacter(flags);
      case "clawd":
        return await cmdClawd(flags);
      case "modes":
        return await cmdModes(flags);
      case "mode":
        return await cmdMode(flags, rest[0]);
      case "paths":
        return await cmdPaths(flags);
      case "greeting":
        return await cmdGreeting(flags);
      default:
        console.error(`unknown command: ${command}`);
        console.error(`commands: ${COMMANDS.join(", ")}`);
        return 1;
    }
  } catch (err) {
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: String(err?.message ?? err),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(String(err?.stack ?? err));
    }
    return 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(await main(process.argv.slice(2)));
}

export { main, COMMANDS };
