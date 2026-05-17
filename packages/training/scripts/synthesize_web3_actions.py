"""Synthesize ~900 canonical training records for web3 plugin actions.

Targets 9 actions across plugin-evm and plugin-solana. Emits the canonical
flat eliza shape (see SCHEMA.md / lib/eliza_record.py) with native JSON
`tool_calls[N]` envelopes as `expectedResponse`.

Output:
  data/synthesized/action_examples/web3.jsonl   (~900 records)

Each action gets ~70 English + ~30 multilingual (zh/es/fr/ja/de/pt) records
across 10+ message styles, 20+ personas, and varied memoryEntries lengths.
5-10% of records per action are subtle-null cases (missing required fields)
that emit a `thought:/text:` REPLY shape instead of a tool_call.

Run:
    .venv/bin/python scripts/synthesize_web3_actions.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_REPLY,
    ACTION_TASK_CALL,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

OUT_PATH = ROOT / "data" / "synthesized" / "action_examples" / "web3.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-web3")


# ───────────────────────────── shared pools ─────────────────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "eliza", "Eliza", "Hex", "Cipher", "Onchain", "Forge",
]

# 22 personas — varied crypto-user archetypes
PERSONAS = [
    {"id": "alice_defi", "style": "defi-veteran", "tone": "casual"},
    {"id": "bob_yield", "style": "yield-farmer", "tone": "abbrev"},
    {"id": "carlos_ops", "style": "treasury-ops", "tone": "formal"},
    {"id": "diana_dao", "style": "dao-contributor", "tone": "polite"},
    {"id": "ethan_trader", "style": "swing-trader", "tone": "blunt"},
    {"id": "fatima_l2", "style": "l2-power-user", "tone": "casual"},
    {"id": "george_nft", "style": "nft-collector", "tone": "casual"},
    {"id": "hina_jp", "style": "jp-degen", "tone": "polite"},
    {"id": "ivan_dev", "style": "smart-contract-dev", "tone": "concise"},
    {"id": "jin_sol", "style": "solana-native", "tone": "casual"},
    {"id": "kira_arb", "style": "arbitrage-bot-runner", "tone": "blunt"},
    {"id": "leo_newbie", "style": "first-time-user", "tone": "uncertain"},
    {"id": "mia_pm", "style": "crypto-pm", "tone": "formal"},
    {"id": "noah_audit", "style": "auditor", "tone": "formal"},
    {"id": "olivia_lp", "style": "liquidity-provider", "tone": "casual"},
    {"id": "priya_in", "style": "indian-trader", "tone": "casual"},
    {"id": "quinn_quant", "style": "quant", "tone": "concise"},
    {"id": "raj_validator", "style": "validator-op", "tone": "concise"},
    {"id": "sofia_es", "style": "es-degen", "tone": "casual"},
    {"id": "tomas_pt", "style": "pt-trader", "tone": "casual"},
    {"id": "uli_de", "style": "de-treasurer", "tone": "formal"},
    {"id": "yuki_jp", "style": "jp-treasurer", "tone": "polite"},
]

ROOM_KINDS = [
    "dm", "channel:general", "channel:trading", "channel:treasury",
    "channel:dao-ops", "channel:eth-watch", "channel:sol-watch",
    "channel:bridge-talk", "channel:gov", "channel:onchain-ops",
]
CHANNELS = ["dm", "public", "voice"]


def random_room_meta(rng: random.Random) -> tuple[str, str]:
    kind = rng.choice(ROOM_KINDS)
    if kind == "dm":
        return "dm", "dm"
    return kind, rng.choice(["public", "dm", "voice"])


# ───────────────────────────── crypto pools ─────────────────────────────

# EVM chains using viem chain keys (the spec uses SupportedChain = keyof viemChains)
EVM_CHAINS = ["mainnet", "polygon", "arbitrum", "optimism", "base", "bsc"]

# Friendly chain names that users actually type
EVM_CHAIN_ALIASES = {
    "mainnet": ["ethereum", "eth", "mainnet", "L1"],
    "polygon": ["polygon", "matic"],
    "arbitrum": ["arbitrum", "arb", "arbitrum one"],
    "optimism": ["optimism", "OP mainnet", "op"],
    "base": ["base", "Base"],
    "bsc": ["BSC", "BNB chain", "binance smart chain"],
}

EVM_TOKENS = [
    "ETH", "USDC", "USDT", "WBTC", "DAI", "MATIC", "ARB", "OP",
    "BNB", "WETH", "stETH", "rETH", "FRAX", "LINK", "UNI", "AAVE",
]
SOL_TOKENS = ["SOL", "USDC", "USDT", "JUP", "BONK", "RAY", "ORCA", "PYTH", "JTO", "WIF"]


def make_eth_address(rng: random.Random) -> str:
    return "0x" + "".join(rng.choices("0123456789abcdef", k=40))


def make_sol_address(rng: random.Random) -> str:
    # base58 alphabet (no 0, O, I, l)
    alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    return "".join(rng.choices(alpha, k=44))


def make_tx_hash(rng: random.Random) -> str:
    return "0x" + "".join(rng.choices("0123456789abcdef", k=64))


def make_proposal_id(rng: random.Random) -> str:
    # On-chain governor proposal ids are big uint256 — emit as decimal string.
    return str(rng.randint(10**40, 10**45))


def small_amount(rng: random.Random) -> str:
    return rng.choice(["0.01", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10"])


def medium_amount(rng: random.Random) -> str:
    return rng.choice(["50", "100", "250", "500", "750", "1000", "1500", "2500"])


def large_amount(rng: random.Random) -> str:
    return rng.choice(["10000", "25000", "50000", "100000", "250000", "1000000"])


def any_amount(rng: random.Random) -> str:
    return rng.choice([small_amount(rng), medium_amount(rng), large_amount(rng)])


# ───────────────────────────── scenario factories ─────────────────────────

def evm_transfer_scenario(rng: random.Random) -> dict[str, Any]:
    chain = rng.choice(EVM_CHAINS)
    token = rng.choice(EVM_TOKENS)
    return {
        "fromChain": chain,
        "chain_alias": rng.choice(EVM_CHAIN_ALIASES[chain]),
        "toAddress": make_eth_address(rng),
        "amount": any_amount(rng),
        "token": token,
    }


def evm_swap_scenario(rng: random.Random) -> dict[str, Any]:
    chain = rng.choice(EVM_CHAINS)
    from_t, to_t = rng.sample(EVM_TOKENS, 2)
    return {
        "chain": chain,
        "chain_alias": rng.choice(EVM_CHAIN_ALIASES[chain]),
        "fromToken": from_t,
        "toToken": to_t,
        "amount": any_amount(rng),
    }


def evm_bridge_scenario(rng: random.Random) -> dict[str, Any]:
    src, dst = rng.sample(EVM_CHAINS, 2)
    token = rng.choice(EVM_TOKENS)
    sc: dict[str, Any] = {
        "fromChain": src,
        "toChain": dst,
        "from_alias": rng.choice(EVM_CHAIN_ALIASES[src]),
        "to_alias": rng.choice(EVM_CHAIN_ALIASES[dst]),
        "fromToken": token,
        "toToken": token,
        "amount": any_amount(rng),
    }
    if rng.random() < 0.4:
        sc["toAddress"] = make_eth_address(rng)
    return sc


def gov_propose_scenario(rng: random.Random) -> dict[str, Any]:
    chain = rng.choice(EVM_CHAINS)
    n_targets = rng.choice([1, 1, 2, 3])
    return {
        "chain": chain,
        "chain_alias": rng.choice(EVM_CHAIN_ALIASES[chain]),
        "governor": make_eth_address(rng),
        "targets": [make_eth_address(rng) for _ in range(n_targets)],
        "values": [str(0) for _ in range(n_targets)],
        "calldatas": ["0x" + "".join(rng.choices("0123456789abcdef", k=rng.choice([8, 64, 136]))) for _ in range(n_targets)],
        "description": rng.choice([
            "Increase emissions cap by 5%",
            "Migrate treasury to new multisig",
            "Allocate 250k USDC to grants program Q3",
            "Pause minting for 30 days",
            "Update fee parameter from 30 bps to 25 bps",
            "Onboard new oracle provider",
            "Reduce quorum threshold to 4%",
            "Fund audit budget for v3 contracts",
        ]),
    }


def gov_vote_scenario(rng: random.Random) -> dict[str, Any]:
    chain = rng.choice(EVM_CHAINS)
    return {
        "chain": chain,
        "chain_alias": rng.choice(EVM_CHAIN_ALIASES[chain]),
        "governor": make_eth_address(rng),
        "proposalId": make_proposal_id(rng),
        "support": rng.choice(["FOR", "AGAINST", "ABSTAIN"]),
    }


def gov_queue_scenario(rng: random.Random) -> dict[str, Any]:
    sc = gov_propose_scenario(rng)
    return sc


def gov_execute_scenario(rng: random.Random) -> dict[str, Any]:
    sc = gov_propose_scenario(rng)
    sc["proposalId"] = make_proposal_id(rng)
    return sc


def sol_transfer_scenario(rng: random.Random) -> dict[str, Any]:
    is_native = rng.random() < 0.5
    token = "SOL" if is_native else rng.choice(SOL_TOKENS[1:])
    return {
        "tokenAddress": None if is_native else make_sol_address(rng),
        "tokenSymbol": token,
        "recipient": make_sol_address(rng),
        "amount": any_amount(rng),
    }


def sol_swap_scenario(rng: random.Random) -> dict[str, Any]:
    in_t, out_t = rng.sample(SOL_TOKENS, 2)
    return {
        "inputTokenSymbol": in_t,
        "outputTokenSymbol": out_t,
        "inputTokenCA": None if in_t == "SOL" else make_sol_address(rng),
        "outputTokenCA": None if out_t == "SOL" else make_sol_address(rng),
        "amount": any_amount(rng),
    }


# ───────────────────────────── language pools ───────────────────────────

# 70 EN, 30 multilingual: zh ja es fr de pt → 5 each = 30
LANGS = ["en"] * 70 + ["zh"] * 5 + ["ja"] * 5 + ["es"] * 5 + ["fr"] * 5 + ["de"] * 5 + ["pt"] * 5
assert len(LANGS) == 100


# ───────────────────────────── EVM TRANSFER phrasings ───────────────────

EVM_TRANSFER_TEMPLATES = {
    "en": [
        "send {amount} {token} to {addr} on {chain}",
        "please transfer {amount} {token} to {addr} ({chain})",
        "transfer {amount} {token} on {chain} → {addr}",
        "yo, push {amount} {token} from {chain} to {addr}",
        "I need to send {amount} {token} to {addr}, use {chain} please",
        "Move {amount} {token} to {addr} on {chain}, thanks",
        "Wire {amount} {token} on {chain} to wallet {addr}",
        "Pay {addr} {amount} {token} from my {chain} wallet",
        "send {addr} {amount} {token}, use the {chain} network",
        "txfer {amount} {token} → {addr}, chain={chain}",
        "Can you fire off {amount} {token} to {addr} on {chain}",
        "{amount} {token} -> {addr} ({chain})",
    ],
    "zh": [
        "请把 {amount} {token} 发送到 {addr},网络:{chain}",
        "在 {chain} 上转 {amount} {token} 给 {addr}",
        "帮我向 {addr} 转 {amount} {token},用 {chain}",
    ],
    "ja": [
        "{chain}で{amount} {token}を{addr}に送ってください",
        "{addr}に{amount} {token}を送金して。チェーンは{chain}",
        "{chain}ネットワークで{amount} {token}を{addr}に転送",
    ],
    "es": [
        "envía {amount} {token} a {addr} en {chain}",
        "transfiere {amount} {token} a {addr} usando {chain}",
        "manda {amount} {token} a {addr} ({chain})",
    ],
    "fr": [
        "envoie {amount} {token} à {addr} sur {chain}",
        "transfère {amount} {token} vers {addr} ({chain})",
        "fais passer {amount} {token} à {addr} sur le réseau {chain}",
    ],
    "de": [
        "sende {amount} {token} an {addr} auf {chain}",
        "überweise {amount} {token} an {addr} ({chain})",
        "schick {amount} {token} an {addr} im {chain}-Netz",
    ],
    "pt": [
        "envie {amount} {token} para {addr} em {chain}",
        "transfira {amount} {token} para {addr} ({chain})",
        "manda {amount} {token} pro {addr} na {chain}",
    ],
}


EVM_SWAP_TEMPLATES = {
    "en": [
        "swap {amount} {fromToken} for {toToken} on {chain}",
        "trade {amount} {fromToken} → {toToken} ({chain})",
        "exchange {amount} {fromToken} for some {toToken}, chain={chain}",
        "convert {amount} {fromToken} to {toToken} on {chain} please",
        "{chain}: swap {amount} {fromToken} into {toToken}",
        "do a swap: {amount} {fromToken} -> {toToken} on {chain}",
        "let's flip {amount} {fromToken} for {toToken} on {chain}",
        "swap me out of {fromToken} into {toToken}, {amount} on {chain}",
        "execute: {amount} {fromToken} → {toToken}, network {chain}",
        "{amount} {fromToken} for {toToken}, use {chain}",
        "Trade {amount} of my {fromToken} into {toToken} via {chain}",
        "I want to swap {amount} {fromToken} for {toToken} on {chain}",
    ],
    "zh": [
        "在 {chain} 上把 {amount} {fromToken} 换成 {toToken}",
        "用 {amount} {fromToken} 兑换 {toToken},网络 {chain}",
        "把 {amount} {fromToken} 换成 {toToken},链是 {chain}",
    ],
    "ja": [
        "{chain}で{amount} {fromToken}を{toToken}にスワップして",
        "{amount} {fromToken}を{toToken}に交換、ネットワークは{chain}",
        "{chain}上で{amount} {fromToken}→{toToken}",
    ],
    "es": [
        "intercambia {amount} {fromToken} por {toToken} en {chain}",
        "swap de {amount} {fromToken} a {toToken} ({chain})",
        "cambia {amount} {fromToken} a {toToken} en {chain}",
    ],
    "fr": [
        "échange {amount} {fromToken} contre {toToken} sur {chain}",
        "swap de {amount} {fromToken} vers {toToken} ({chain})",
        "convertis {amount} {fromToken} en {toToken} sur {chain}",
    ],
    "de": [
        "tausche {amount} {fromToken} gegen {toToken} auf {chain}",
        "Swap {amount} {fromToken} → {toToken} ({chain})",
        "wechsle {amount} {fromToken} in {toToken} auf {chain}",
    ],
    "pt": [
        "troque {amount} {fromToken} por {toToken} em {chain}",
        "swap de {amount} {fromToken} para {toToken} ({chain})",
        "converta {amount} {fromToken} em {toToken} na {chain}",
    ],
}


CROSS_CHAIN_TEMPLATES = {
    "en": [
        "bridge {amount} {fromToken} from {fromChain} to {toChain}",
        "move {amount} {fromToken} from {fromChain} → {toChain}",
        "send {amount} {fromToken} cross-chain {fromChain} to {toChain}",
        "bridge {amount} {fromToken} {fromChain}→{toChain}, recipient {toAddress}",
        "I want to bridge {amount} {fromToken} {fromChain} to {toChain}",
        "L2 hop: {amount} {fromToken} from {fromChain} to {toChain}",
        "Bridge me {amount} {fromToken} {fromChain} -> {toChain}",
        "transport {amount} {fromToken} from {fromChain} into {toChain}",
        "Cross {amount} {fromToken} over from {fromChain} to {toChain}",
        "Bridge {amount} {fromToken} {fromChain} to {toChain} please",
        "Move my {fromToken} ({amount}) from {fromChain} to {toChain}",
        "Bridge {amount} {fromToken} from {fromChain} to {toChain} for {toAddress}",
    ],
    "zh": [
        "把 {amount} {fromToken} 从 {fromChain} 跨链到 {toChain}",
        "桥接 {amount} {fromToken} 从 {fromChain} 到 {toChain}",
        "{fromChain} → {toChain} 跨链 {amount} {fromToken}",
    ],
    "ja": [
        "{amount} {fromToken}を{fromChain}から{toChain}にブリッジして",
        "{fromChain}→{toChain}に{amount} {fromToken}を移動",
        "クロスチェーンで{amount} {fromToken}を{fromChain}から{toChain}へ",
    ],
    "es": [
        "haz un bridge de {amount} {fromToken} desde {fromChain} a {toChain}",
        "mueve {amount} {fromToken} de {fromChain} a {toChain}",
        "puente: {amount} {fromToken} {fromChain} → {toChain}",
    ],
    "fr": [
        "bridge {amount} {fromToken} de {fromChain} vers {toChain}",
        "fais passer {amount} {fromToken} de {fromChain} à {toChain}",
        "cross-chain {amount} {fromToken} {fromChain} → {toChain}",
    ],
    "de": [
        "bridge {amount} {fromToken} von {fromChain} nach {toChain}",
        "verschiebe {amount} {fromToken} von {fromChain} auf {toChain}",
        "Cross-Chain: {amount} {fromToken} {fromChain} → {toChain}",
    ],
    "pt": [
        "faça bridge de {amount} {fromToken} de {fromChain} para {toChain}",
        "mova {amount} {fromToken} de {fromChain} para {toChain}",
        "cross-chain {amount} {fromToken} {fromChain} → {toChain}",
    ],
}


GOV_PROPOSE_TEMPLATES = {
    "en": [
        "propose on governor {governor} ({chain}): {description}",
        "create a governance proposal on {chain}, governor {governor}: {description}",
        "submit proposal: {description} via governor {governor} on {chain}",
        "I want to propose: {description} (governor {governor}, chain {chain})",
        "draft a proposal on {chain}'s {governor}: {description}",
        "new DAO proposal: {description}. Use {governor} on {chain}",
        "kick off proposal '{description}' on governor {governor} ({chain})",
        "let's submit: {description}, governor={governor}, chain={chain}",
        "open governance proposal on {chain}: {description} ({governor})",
        "file proposal '{description}' to {governor} on {chain}",
    ],
    "zh": [
        "在 {chain} 上向治理合约 {governor} 提案:{description}",
        "提交一个治理提案到 {governor},网络 {chain}:{description}",
        "在 {chain} 的 {governor} 上发起提案:{description}",
    ],
    "ja": [
        "{chain}のガバナンス {governor} に提案を作成:{description}",
        "DAOガバナンス提案を{governor}({chain})に提出:{description}",
        "{chain}上の{governor}で提案を起こす:{description}",
    ],
    "es": [
        "crea una propuesta en el gobernador {governor} ({chain}): {description}",
        "envía la propuesta '{description}' al governor {governor} en {chain}",
        "propuesta de gobernanza en {chain}, governor {governor}: {description}",
    ],
    "fr": [
        "crée une proposition sur le governor {governor} ({chain}): {description}",
        "soumets la proposition '{description}' à {governor} sur {chain}",
        "nouvelle proposition de gouvernance sur {chain}: {description}",
    ],
    "de": [
        "erstelle einen Governance-Vorschlag auf {governor} ({chain}): {description}",
        "neuer DAO-Vorschlag auf {chain}: {description} (governor {governor})",
        "Vorschlag '{description}' auf {governor} ({chain}) einreichen",
    ],
    "pt": [
        "crie uma proposta no governor {governor} ({chain}): {description}",
        "envie a proposta '{description}' para o governor {governor} em {chain}",
        "nova proposta de governança em {chain}: {description}",
    ],
}


GOV_VOTE_TEMPLATES = {
    "en": [
        "vote {support} on proposal {proposalId} ({chain}, governor {governor})",
        "cast {support} on prop {proposalId} on {chain}, governor={governor}",
        "{support} on proposal {proposalId} via {governor} ({chain})",
        "vote {support} for proposal id {proposalId} on {chain}",
        "I'm voting {support} on {proposalId} ({chain}, {governor})",
        "submit a {support} vote on prop {proposalId} on {chain}",
        "register my {support} vote, proposal {proposalId}, chain {chain}",
        "log {support} for {proposalId}, governor {governor} on {chain}",
        "{support} on {proposalId} please ({chain})",
        "lock in {support} on prop {proposalId} ({chain}/{governor})",
    ],
    "zh": [
        "在 {chain} 的 {governor} 上对提案 {proposalId} 投 {support}",
        "为提案 {proposalId} 投 {support} 票,网络 {chain}",
        "{governor}({chain})提案 {proposalId},投票:{support}",
    ],
    "ja": [
        "{chain}の{governor}で提案{proposalId}に{support}で投票",
        "提案ID {proposalId} に {support} で投票({chain})",
        "{chain}上、{governor}の{proposalId}に{support}",
    ],
    "es": [
        "vota {support} en la propuesta {proposalId} ({chain}, governor {governor})",
        "registra {support} en {proposalId} en {chain}",
        "voto {support} para la propuesta {proposalId} ({chain})",
    ],
    "fr": [
        "vote {support} sur la proposition {proposalId} ({chain}, governor {governor})",
        "enregistre {support} sur {proposalId} sur {chain}",
        "{support} sur la prop {proposalId} ({chain})",
    ],
    "de": [
        "stimme {support} auf Vorschlag {proposalId} ({chain}, governor {governor})",
        "{support} auf Proposal {proposalId} ({chain}) abgeben",
        "Vote {support} auf {proposalId} im {governor} ({chain})",
    ],
    "pt": [
        "vote {support} na proposta {proposalId} ({chain}, governor {governor})",
        "registre {support} em {proposalId} na {chain}",
        "voto {support} para a proposta {proposalId} ({chain})",
    ],
}


GOV_QUEUE_TEMPLATES = {
    "en": [
        "queue proposal on governor {governor} ({chain}): {description}",
        "queue the passed proposal on {chain}, governor {governor}",
        "queue: {description}, governor {governor}, chain {chain}",
        "send the proposal to the queue on {chain} ({governor})",
        "queue up the executed proposal {description} on {chain}",
        "ready to queue this proposal on {governor} ({chain}): {description}",
        "let's queue {description} on {chain} via {governor}",
        "queue the prop on {chain}: {description} ({governor})",
        "go ahead and queue '{description}' on {governor} ({chain})",
        "Queue prop on {chain} (gov {governor}): {description}",
    ],
    "zh": [
        "将提案排队到 {chain} 的 {governor}:{description}",
        "在 {chain} 上把提案 '{description}' 加入队列,治理合约 {governor}",
        "queue 提案 {description} 到 {governor}({chain})",
    ],
    "ja": [
        "{chain}の{governor}で提案をキューに入れる:{description}",
        "可決済み提案 '{description}' を {governor}({chain}) でキュー",
        "{chain}上、提案 {description} をキューイング",
    ],
    "es": [
        "encola la propuesta en {governor} ({chain}): {description}",
        "queue la propuesta '{description}' en {chain}",
        "pon en cola la propuesta en {governor} ({chain}): {description}",
    ],
    "fr": [
        "mets en file la proposition sur {governor} ({chain}): {description}",
        "queue la proposition '{description}' sur {chain}",
        "place dans la queue la prop sur {governor} ({chain}): {description}",
    ],
    "de": [
        "stelle den Vorschlag in die Queue auf {governor} ({chain}): {description}",
        "Proposal '{description}' auf {chain} queuen ({governor})",
        "queue den Vorschlag auf {governor} ({chain}): {description}",
    ],
    "pt": [
        "coloque a proposta na fila em {governor} ({chain}): {description}",
        "queue a proposta '{description}' em {chain}",
        "envie pra fila a prop em {governor} ({chain}): {description}",
    ],
}


GOV_EXECUTE_TEMPLATES = {
    "en": [
        "execute proposal {proposalId} on {chain} via governor {governor}",
        "run the queued proposal {proposalId} ({chain}, {governor}): {description}",
        "execute: prop {proposalId} on {governor} ({chain})",
        "fire the execute on proposal {proposalId} ({chain})",
        "ship it — execute {proposalId} on {chain} ({governor})",
        "let's execute the queued prop {proposalId} on {chain}",
        "run execute() for prop {proposalId} on {governor} ({chain})",
        "submit execute for {proposalId} on {chain}",
        "execute prop {proposalId} ({description}) on {governor} ({chain})",
        "go: execute {proposalId} on {governor} ({chain})",
    ],
    "zh": [
        "在 {chain} 的 {governor} 上执行提案 {proposalId}",
        "执行已排队的提案 {proposalId},{chain},{governor}",
        "{governor}({chain}) 执行提案 {proposalId}",
    ],
    "ja": [
        "{chain}の{governor}で提案 {proposalId} を実行",
        "キュー済み提案 {proposalId} を実行({chain},{governor})",
        "{governor}({chain})で提案 {proposalId} を execute",
    ],
    "es": [
        "ejecuta la propuesta {proposalId} en {chain} via {governor}",
        "execute prop {proposalId} en {governor} ({chain})",
        "ejecuta {proposalId} en {chain}, governor {governor}",
    ],
    "fr": [
        "exécute la proposition {proposalId} sur {chain} via {governor}",
        "execute prop {proposalId} sur {governor} ({chain})",
        "lance l'exécution de {proposalId} sur {chain}",
    ],
    "de": [
        "führe Vorschlag {proposalId} auf {chain} via {governor} aus",
        "execute Prop {proposalId} auf {governor} ({chain})",
        "Vorschlag {proposalId} ausführen auf {chain}",
    ],
    "pt": [
        "execute a proposta {proposalId} em {chain} via {governor}",
        "rode execute na prop {proposalId} ({governor}, {chain})",
        "execute {proposalId} em {chain}, governor {governor}",
    ],
}


SOL_TRANSFER_TEMPLATES = {
    "en": [
        "send {amount} {tokenSymbol} to {recipient}",
        "transfer {amount} {tokenSymbol} to {recipient} on Solana",
        "Solana: send {amount} {tokenSymbol} to {recipient}",
        "yo, push {amount} {tokenSymbol} to {recipient}",
        "pay {recipient} {amount} {tokenSymbol}",
        "wire {amount} {tokenSymbol} to wallet {recipient}",
        "Solana transfer: {amount} {tokenSymbol} → {recipient}",
        "send {recipient} {amount} {tokenSymbol} please",
        "tx: {amount} {tokenSymbol} -> {recipient}",
        "I need to send {amount} {tokenSymbol} to {recipient}",
        "Move {amount} {tokenSymbol} to {recipient}",
        "{amount} {tokenSymbol} to {recipient} on sol",
    ],
    "zh": [
        "发送 {amount} {tokenSymbol} 到 {recipient}(Solana)",
        "在 Solana 上转 {amount} {tokenSymbol} 给 {recipient}",
        "向 {recipient} 转 {amount} {tokenSymbol}",
    ],
    "ja": [
        "{recipient}に{amount} {tokenSymbol}を送って",
        "Solanaで{amount} {tokenSymbol}を{recipient}に送金",
        "{recipient}宛に{amount} {tokenSymbol}",
    ],
    "es": [
        "envía {amount} {tokenSymbol} a {recipient} en Solana",
        "transfiere {amount} {tokenSymbol} a {recipient}",
        "manda {amount} {tokenSymbol} a {recipient}",
    ],
    "fr": [
        "envoie {amount} {tokenSymbol} à {recipient} sur Solana",
        "transfère {amount} {tokenSymbol} vers {recipient}",
        "fais passer {amount} {tokenSymbol} à {recipient}",
    ],
    "de": [
        "sende {amount} {tokenSymbol} an {recipient} auf Solana",
        "überweise {amount} {tokenSymbol} an {recipient}",
        "schick {amount} {tokenSymbol} an {recipient}",
    ],
    "pt": [
        "envie {amount} {tokenSymbol} para {recipient} em Solana",
        "transfira {amount} {tokenSymbol} para {recipient}",
        "manda {amount} {tokenSymbol} para {recipient}",
    ],
}


SOL_SWAP_TEMPLATES = {
    "en": [
        "swap {amount} {inputTokenSymbol} for {outputTokenSymbol} on Solana",
        "trade {amount} {inputTokenSymbol} → {outputTokenSymbol}",
        "Solana swap: {amount} {inputTokenSymbol} into {outputTokenSymbol}",
        "convert {amount} {inputTokenSymbol} to {outputTokenSymbol} via jup",
        "let's flip {amount} {inputTokenSymbol} for {outputTokenSymbol} on sol",
        "do a jupiter swap: {amount} {inputTokenSymbol} -> {outputTokenSymbol}",
        "exchange {amount} {inputTokenSymbol} for {outputTokenSymbol}",
        "swap me out of {inputTokenSymbol}: {amount} into {outputTokenSymbol}",
        "execute swap on Solana: {amount} {inputTokenSymbol} → {outputTokenSymbol}",
        "I want to swap {amount} {inputTokenSymbol} for {outputTokenSymbol}",
        "{amount} {inputTokenSymbol} → {outputTokenSymbol} on sol",
        "trade {amount} of my {inputTokenSymbol} into {outputTokenSymbol}",
    ],
    "zh": [
        "在 Solana 上把 {amount} {inputTokenSymbol} 兑换为 {outputTokenSymbol}",
        "用 {amount} {inputTokenSymbol} 兑换 {outputTokenSymbol}",
        "Solana swap: {amount} {inputTokenSymbol} -> {outputTokenSymbol}",
    ],
    "ja": [
        "Solanaで{amount} {inputTokenSymbol}を{outputTokenSymbol}にスワップ",
        "{amount} {inputTokenSymbol}を{outputTokenSymbol}に交換(Sol)",
        "Jupiterで{amount} {inputTokenSymbol}→{outputTokenSymbol}",
    ],
    "es": [
        "intercambia {amount} {inputTokenSymbol} por {outputTokenSymbol} en Solana",
        "swap de {amount} {inputTokenSymbol} a {outputTokenSymbol}",
        "cambia {amount} {inputTokenSymbol} a {outputTokenSymbol} via Jupiter",
    ],
    "fr": [
        "échange {amount} {inputTokenSymbol} contre {outputTokenSymbol} sur Solana",
        "swap de {amount} {inputTokenSymbol} en {outputTokenSymbol}",
        "convertis {amount} {inputTokenSymbol} en {outputTokenSymbol} via Jupiter",
    ],
    "de": [
        "tausche {amount} {inputTokenSymbol} gegen {outputTokenSymbol} auf Solana",
        "Swap {amount} {inputTokenSymbol} → {outputTokenSymbol}",
        "wechsle {amount} {inputTokenSymbol} in {outputTokenSymbol} via Jupiter",
    ],
    "pt": [
        "troque {amount} {inputTokenSymbol} por {outputTokenSymbol} em Solana",
        "swap de {amount} {inputTokenSymbol} para {outputTokenSymbol}",
        "converta {amount} {inputTokenSymbol} em {outputTokenSymbol} via Jupiter",
    ],
}


# ───────────────────────────── memory entry pools ───────────────────────

# Crypto-flavored prior context messages — varied lengths from 0 to 5 entries.
PRIOR_USER_CONTEXT = [
    "checking my wallet balance first",
    "wallet's looking good today",
    "got some gas saved up",
    "treasury approved this last week",
    "DAO greenlit it yesterday",
    "I synced my hardware wallet",
    "yesterday's swap settled fine",
    "block confirmations are quick rn",
    "fees are low on L2 today",
    "checked the explorer, all good",
    "approved the spend allowance already",
    "wallet connected via walletconnect",
]

PRIOR_AGENT_CONTEXT = [
    "Got it — I have your wallet linked.",
    "Sure, gas is reasonable on that chain rn.",
    "Acknowledged — I can route that for you.",
    "I see your prior approval, ready when you are.",
    "Network looks healthy — fees low.",
    "I'll need final confirmation before signing.",
    "Yep, last txn settled in 12s.",
    "Your balance covers the planned op.",
    "OK, I'll prepare the transaction.",
]


def make_memory(rng: random.Random, n: int, persona_id: str) -> list[dict[str, Any]]:
    if n == 0:
        return []
    out: list[dict[str, Any]] = []
    role_cycle = ["user", "assistant"]
    for i in range(n):
        role = role_cycle[i % 2]
        if role == "user":
            content = rng.choice(PRIOR_USER_CONTEXT)
            speaker = persona_id
        else:
            content = rng.choice(PRIOR_AGENT_CONTEXT)
            speaker = "agent"
        out.append({"role": role, "speaker": speaker, "content": content, "channel": "dm"})
    return out


# ───────────────────────────── builders ────────────────────────────────

def build_record(
    *,
    encoder: ExpectedResponseEncoder,
    action_name: str,
    plugin: str,
    user_msg: str,
    expected: dict[str, Any] | str,
    available_actions: list[str],
    rng: random.Random,
    persona: dict[str, Any],
    n_memory: int,
    language: str,
    is_subtle_null: bool,
    extra_md: dict[str, Any] | None = None,
) -> dict[str, Any]:
    agent = rng.choice(AGENT_NAMES)
    user = persona["id"]
    room, channel = random_room_meta(rng)

    if isinstance(expected, str):
        expected_str = expected
    else:
        expected_str = encoder.encode(expected)

    memory = make_memory(rng, n_memory, user)

    md: dict[str, Any] = {
        "agent_name": agent,
        "action_name": action_name,
        "synth_plugin": plugin,
        "language": language,
        "persona": persona["id"],
        "style": persona["style"],
        "tone": persona["tone"],
        "n_memory": n_memory,
        "subtle_null": is_subtle_null,
    }
    if extra_md:
        md.update(extra_md)

    rec = build(
        roomName=stable_id("synth-web3", action_name, plugin, user_msg, agent, str(rng.random())),
        agentId=agent.lower(),
        memoryEntries=memory,
        currentMessage={
            "role": "user",
            "speaker": user,
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=available_actions,
        task_type="tool_call",
        source_dataset="synth-web3-actions",
        license="synthetic",
        split="train",
        extra_metadata=md,
    )
    return rec.to_dict()


# ───────────────────────────── per-action generators ────────────────────


SUBTLE_NULL_THOUGHTS = {
    "amount": [
        "User mentioned a swap but didn't specify the amount.",
        "Need the amount before I can build this transaction.",
        "Missing amount — can't construct the call.",
    ],
    "address": [
        "No recipient address provided yet.",
        "Need the destination wallet first.",
        "Missing destination address.",
    ],
    "chain": [
        "User didn't specify which chain.",
        "Need the network before routing.",
        "Chain isn't clear from the message.",
    ],
    "token": [
        "Which token? Not specified yet.",
        "Token symbol/address still missing.",
    ],
    "proposal": [
        "Need the proposal id first.",
        "Missing the proposal identifier.",
    ],
    "support": [
        "Vote direction not specified — for, against, or abstain?",
        "User said 'vote' but didn't say which way.",
    ],
    "governor": [
        "Need the governor contract address.",
        "Missing the governor address.",
    ],
}

SUBTLE_NULL_ASKS = {
    "amount": [
        "How much do you want to swap?",
        "What amount should I send?",
        "Can you confirm the amount?",
    ],
    "address": [
        "What's the destination address?",
        "Which wallet should I send it to?",
    ],
    "chain": [
        "Which chain — Ethereum, Polygon, Arbitrum…?",
        "Which network do you want to use?",
    ],
    "token": [
        "Which token?",
        "What token would you like to use?",
    ],
    "proposal": [
        "What's the proposal id?",
        "Which proposal id should I act on?",
    ],
    "support": [
        "Vote FOR, AGAINST, or ABSTAIN?",
        "Which way are you voting?",
    ],
    "governor": [
        "What's the governor contract address?",
        "Which governor contract?",
    ],
}


def fmt(template: str, **kwargs) -> str:
    return template.format(**kwargs)


def gen_evm_transfer(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 2, 3, 4, 5])
        sc = evm_transfer_scenario(rng)
        is_null = rng.random() < 0.07  # ~7% subtle null

        templates = EVM_TRANSFER_TEMPLATES[lang]
        if is_null:
            # Drop one critical field from the user msg
            drop = rng.choice(["amount", "address"])
            if drop == "amount":
                # render template but with amount blank (and patch wording)
                msg = (
                    "send some {token} to {addr} on {chain}"
                    if lang == "en"
                    else fmt(rng.choice(templates), amount="", token=sc["token"],
                             addr=sc["toAddress"], chain=sc["chain_alias"]).replace(" ,", ",")
                )
                if lang == "en":
                    msg = msg.format(token=sc["token"], addr=sc["toAddress"], chain=sc["chain_alias"])
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["amount"])
                ask = rng.choice(SUBTLE_NULL_ASKS["amount"])
            else:
                msg = (f"send {sc['amount']} {sc['token']} on {sc['chain_alias']}"
                       if lang == "en" else
                       f"{sc['amount']} {sc['token']} → ?  ({sc['chain_alias']})")
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["address"])
                ask = rng.choice(SUBTLE_NULL_ASKS["address"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="TRANSFER", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "TRANSFER"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            amount=sc["amount"], token=sc["token"],
            addr=sc["toAddress"], chain=sc["chain_alias"],
        )
        args: dict[str, Any] = {
            "fromChain": sc["fromChain"],
            "toAddress": sc["toAddress"],
            "amount": sc["amount"],
            "token": sc["token"],
        }
        expected = {"tool_calls": [{"name": "TRANSFER", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="TRANSFER", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "TRANSFER"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_evm_swap(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 3, 4, 5])
        sc = evm_swap_scenario(rng)
        is_null = rng.random() < 0.07
        templates = EVM_SWAP_TEMPLATES[lang]

        if is_null:
            drop = rng.choice(["amount", "chain"])
            if drop == "amount":
                msg = (f"swap {sc['fromToken']} for {sc['toToken']} on {sc['chain_alias']}"
                       if lang == "en" else
                       f"{sc['fromToken']} → {sc['toToken']} ({sc['chain_alias']})")
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["amount"])
                ask = rng.choice(SUBTLE_NULL_ASKS["amount"])
            else:
                msg = f"swap {sc['amount']} {sc['fromToken']} for {sc['toToken']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["chain"])
                ask = rng.choice(SUBTLE_NULL_ASKS["chain"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="SWAP", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "SWAP"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            amount=sc["amount"], fromToken=sc["fromToken"],
            toToken=sc["toToken"], chain=sc["chain_alias"],
        )
        args = {
            "chain": sc["chain"],
            "fromToken": sc["fromToken"],
            "toToken": sc["toToken"],
            "amount": sc["amount"],
        }
        expected = {"tool_calls": [{"name": "SWAP", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="SWAP", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "SWAP"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_cross_chain_transfer(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 3, 4, 5])
        sc = evm_bridge_scenario(rng)
        is_null = rng.random() < 0.06
        templates = CROSS_CHAIN_TEMPLATES[lang]

        if is_null:
            drop = rng.choice(["amount", "chain", "token"])
            if drop == "amount":
                msg = f"bridge {sc['fromToken']} from {sc['from_alias']} to {sc['to_alias']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["amount"])
                ask = rng.choice(SUBTLE_NULL_ASKS["amount"])
            elif drop == "chain":
                msg = f"bridge {sc['amount']} {sc['fromToken']} cross-chain"
                thought = "Source and destination chains aren't specified."
                ask = "Which chain to which chain?"
            else:
                msg = f"bridge {sc['amount']} from {sc['from_alias']} to {sc['to_alias']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["token"])
                ask = rng.choice(SUBTLE_NULL_ASKS["token"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="CROSS_CHAIN_TRANSFER", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "CROSS_CHAIN_TRANSFER"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        tmpl = rng.choice(templates)
        # Some templates need toAddress; fallback if not in scenario
        to_addr = sc.get("toAddress") or make_eth_address(rng)
        msg = fmt(
            tmpl,
            amount=sc["amount"], fromToken=sc["fromToken"], toToken=sc["toToken"],
            fromChain=sc["from_alias"], toChain=sc["to_alias"],
            toAddress=to_addr,
        )
        args: dict[str, Any] = {
            "fromChain": sc["fromChain"],
            "toChain": sc["toChain"],
            "fromToken": sc["fromToken"],
            "toToken": sc["toToken"],
            "amount": sc["amount"],
        }
        if "toAddress" in sc:
            args["toAddress"] = sc["toAddress"]
        expected = {"tool_calls": [{"name": "CROSS_CHAIN_TRANSFER", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="CROSS_CHAIN_TRANSFER", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "CROSS_CHAIN_TRANSFER"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_gov_propose(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 1, 2, 3, 3, 4, 5])
        sc = gov_propose_scenario(rng)
        is_null = rng.random() < 0.06
        templates = GOV_PROPOSE_TEMPLATES[lang]

        if is_null:
            drop = rng.choice(["governor", "chain"])
            if drop == "governor":
                msg = f"propose: {sc['description']} on {sc['chain_alias']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["governor"])
                ask = rng.choice(SUBTLE_NULL_ASKS["governor"])
            else:
                msg = f"propose: {sc['description']} via governor {sc['governor']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["chain"])
                ask = rng.choice(SUBTLE_NULL_ASKS["chain"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="GOV_PROPOSE", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "GOV_PROPOSE"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            governor=sc["governor"], chain=sc["chain_alias"], description=sc["description"],
        )
        args = {
            "chain": sc["chain"],
            "governor": sc["governor"],
            "targets": sc["targets"],
            "values": sc["values"],
            "calldatas": sc["calldatas"],
            "description": sc["description"],
        }
        expected = {"tool_calls": [{"name": "GOV_PROPOSE", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="GOV_PROPOSE", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "GOV_PROPOSE"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_gov_vote(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 3, 4])
        sc = gov_vote_scenario(rng)
        is_null = rng.random() < 0.07
        templates = GOV_VOTE_TEMPLATES[lang]

        if is_null:
            drop = rng.choice(["proposal", "support"])
            if drop == "proposal":
                msg = f"vote {sc['support']} on {sc['chain_alias']} via {sc['governor']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["proposal"])
                ask = rng.choice(SUBTLE_NULL_ASKS["proposal"])
            else:
                msg = f"vote on proposal {sc['proposalId']} ({sc['chain_alias']}, {sc['governor']})"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["support"])
                ask = rng.choice(SUBTLE_NULL_ASKS["support"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="GOV_VOTE", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "GOV_VOTE"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            governor=sc["governor"], chain=sc["chain_alias"],
            proposalId=sc["proposalId"], support=sc["support"],
        )
        args = {
            "chain": sc["chain"],
            "governor": sc["governor"],
            "proposalId": sc["proposalId"],
            "support": sc["support"],
        }
        expected = {"tool_calls": [{"name": "GOV_VOTE", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="GOV_VOTE", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "GOV_VOTE"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_gov_queue(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 1, 2, 3, 4])
        sc = gov_queue_scenario(rng)
        is_null = rng.random() < 0.06
        templates = GOV_QUEUE_TEMPLATES[lang]

        if is_null:
            msg = f"queue this proposal: {sc['description']}"
            thought = rng.choice(SUBTLE_NULL_THOUGHTS["governor"] + SUBTLE_NULL_THOUGHTS["chain"])
            ask = "Which governor and which chain?"
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="GOV_QUEUE", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "GOV_QUEUE"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            governor=sc["governor"], chain=sc["chain_alias"], description=sc["description"],
        )
        args = {
            "chain": sc["chain"],
            "governor": sc["governor"],
            "targets": sc["targets"],
            "values": sc["values"],
            "calldatas": sc["calldatas"],
            "description": sc["description"],
        }
        expected = {"tool_calls": [{"name": "GOV_QUEUE", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="GOV_QUEUE", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "GOV_QUEUE"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_gov_execute(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 1, 2, 3, 4])
        sc = gov_execute_scenario(rng)
        is_null = rng.random() < 0.06
        templates = GOV_EXECUTE_TEMPLATES[lang]

        if is_null:
            msg = f"execute the queued proposal on {sc['chain_alias']}"
            thought = rng.choice(SUBTLE_NULL_THOUGHTS["proposal"])
            ask = rng.choice(SUBTLE_NULL_ASKS["proposal"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="GOV_EXECUTE", plugin="plugin-evm",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "GOV_EXECUTE"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            governor=sc["governor"], chain=sc["chain_alias"],
            description=sc["description"], proposalId=sc["proposalId"],
        )
        args = {
            "chain": sc["chain"],
            "governor": sc["governor"],
            "proposalId": sc["proposalId"],
            "targets": sc["targets"],
            "values": sc["values"],
            "calldatas": sc["calldatas"],
            "description": sc["description"],
        }
        expected = {"tool_calls": [{"name": "GOV_EXECUTE", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="GOV_EXECUTE", plugin="plugin-evm",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "GOV_EXECUTE"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_solana_transfer(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 3, 4, 5])
        sc = sol_transfer_scenario(rng)
        is_null = rng.random() < 0.07
        templates = SOL_TRANSFER_TEMPLATES[lang]

        if is_null:
            drop = rng.choice(["amount", "address"])
            if drop == "amount":
                msg = f"send some {sc['tokenSymbol']} to {sc['recipient']}"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["amount"])
                ask = rng.choice(SUBTLE_NULL_ASKS["amount"])
            else:
                msg = f"send {sc['amount']} {sc['tokenSymbol']} on Solana"
                thought = rng.choice(SUBTLE_NULL_THOUGHTS["address"])
                ask = rng.choice(SUBTLE_NULL_ASKS["address"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="TRANSFER", plugin="plugin-solana",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "TRANSFER"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            amount=sc["amount"], tokenSymbol=sc["tokenSymbol"],
            recipient=sc["recipient"],
        )
        args: dict[str, Any] = {
            "tokenAddress": sc["tokenAddress"],  # null for native SOL
            "recipient": sc["recipient"],
            "amount": sc["amount"],
        }
        expected = {"tool_calls": [{"name": "TRANSFER", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="TRANSFER", plugin="plugin-solana",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "TRANSFER"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


def gen_solana_swap(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterator[dict[str, Any]]:
    langs = LANGS[:n]
    for i in range(n):
        lang = langs[i]
        persona = rng.choice(PERSONAS)
        n_mem = rng.choice([0, 0, 1, 2, 3, 4, 5])
        sc = sol_swap_scenario(rng)
        is_null = rng.random() < 0.07
        templates = SOL_SWAP_TEMPLATES[lang]

        if is_null:
            msg = f"swap {sc['inputTokenSymbol']} for {sc['outputTokenSymbol']} on solana"
            thought = rng.choice(SUBTLE_NULL_THOUGHTS["amount"])
            ask = rng.choice(SUBTLE_NULL_ASKS["amount"])
            expected = {"thought": thought, "text": ask}
            yield build_record(
                encoder=encoder, action_name="SWAP_SOLANA", plugin="plugin-solana",
                user_msg=msg, expected=expected,
                available_actions=[ACTION_REPLY, ACTION_TASK_CALL, "SWAP_SOLANA"],
                rng=rng, persona=persona, n_memory=n_mem, language=lang,
                is_subtle_null=True,
            )
            continue

        msg = fmt(
            rng.choice(templates),
            amount=sc["amount"], inputTokenSymbol=sc["inputTokenSymbol"],
            outputTokenSymbol=sc["outputTokenSymbol"],
        )
        args: dict[str, Any] = {
            "inputTokenSymbol": sc["inputTokenSymbol"],
            "outputTokenSymbol": sc["outputTokenSymbol"],
            "inputTokenCA": sc["inputTokenCA"],
            "outputTokenCA": sc["outputTokenCA"],
            "amount": sc["amount"],
        }
        expected = {"tool_calls": [{"name": "SWAP_SOLANA", "arguments": args}]}
        yield build_record(
            encoder=encoder, action_name="SWAP_SOLANA", plugin="plugin-solana",
            user_msg=msg, expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, "SWAP_SOLANA"],
            rng=rng, persona=persona, n_memory=n_mem, language=lang,
            is_subtle_null=False,
        )


# ───────────────────────────── orchestration ───────────────────────────


GENERATORS: list[tuple[str, str, Any]] = [
    ("CROSS_CHAIN_TRANSFER", "plugin-evm", gen_cross_chain_transfer),
    ("GOV_EXECUTE", "plugin-evm", gen_gov_execute),
    ("GOV_PROPOSE", "plugin-evm", gen_gov_propose),
    ("GOV_QUEUE", "plugin-evm", gen_gov_queue),
    ("GOV_VOTE", "plugin-evm", gen_gov_vote),
    ("SWAP", "plugin-evm", gen_evm_swap),
    ("TRANSFER", "plugin-evm", gen_evm_transfer),
    ("SWAP_SOLANA", "plugin-solana", gen_solana_swap),
    ("TRANSFER", "plugin-solana", gen_solana_transfer),
]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--per-action", type=int, default=100)
    p.add_argument("--seed", type=int, default=0xC1B7DEFA1)
    p.add_argument("--out", type=Path, default=OUT_PATH)
    args = p.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    encoder = JsonExpectedResponseEncoder()
    total = 0
    by_action: dict[str, int] = {}
    null_count: dict[str, int] = {}
    lang_count: dict[str, int] = {}
    persona_count: dict[str, int] = {}
    style_count: dict[str, int] = {}
    try:
        with args.out.open("w", encoding="utf-8") as f:
            for action_name, plugin, gen_fn in GENERATORS:
                rng = random.Random(args.seed ^ hash((action_name, plugin)))
                key = f"{plugin}:{action_name}"
                cnt = 0
                for rec in gen_fn(encoder, rng, args.per_action):
                    f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
                    cnt += 1
                    total += 1
                    md = rec["metadata"]
                    if md.get("subtle_null"):
                        null_count[key] = null_count.get(key, 0) + 1
                    lang_count[md["language"]] = lang_count.get(md["language"], 0) + 1
                    persona_count[md["persona"]] = persona_count.get(md["persona"], 0) + 1
                    style_count[md["style"]] = style_count.get(md["style"], 0) + 1
                by_action[key] = cnt
                log.info("%s/%s: %d records", plugin, action_name, cnt)
    finally:
        encoder.close()

    log.info("Wrote %d records → %s", total, args.out)
    log.info("Per action: %s", json.dumps(by_action, indent=2))
    log.info("Subtle-null counts: %s", json.dumps(null_count, indent=2))
    log.info("Language distribution: %s", json.dumps(lang_count, indent=2))
    log.info("Personas: %d distinct, styles: %d distinct",
             len(persona_count), len(style_count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
