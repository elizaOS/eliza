/**
 * Ground Truth World — v2 (realistic handles, opaque IDs)
 *
 * 14 entities across discord/twitter/telegram.
 * Handles are messy and realistic — no "dave_discord" / "dave_twitter".
 * 3 cross-platform resolution links at easy/medium/hard.
 * 2 anti-links (name collision + adversarial claim).
 */

import type { GroundTruthWorld } from './types';

export const WORLD: GroundTruthWorld = {
  entities: [
    // ── Dave Morales: Discord + Twitter ───────
    // Resolution: MEDIUM — different handles, shared github + project "ChainTracker"
    {
      id: 'ent_d1', canonicalPerson: 'dave',
      displayName: 'd4v3_builds', platform: 'discord', platformHandle: 'd4v3_builds',
      attributes: { project: 'ChainTracker', event: 'ETH Denver' },
    },
    {
      id: 'ent_d2', canonicalPerson: 'dave',
      displayName: 'chaintrack3r', platform: 'twitter', platformHandle: '@chaintrack3r',
      attributes: { project: 'ChainTracker', event: 'ETH Denver' },
    },

    // ── "CryptoWhale" anon: Discord + Twitter ──
    // Resolution: HARD — completely different handles, linked ONLY by self-identification + project "NightOwl"
    {
      id: 'ent_w1', canonicalPerson: 'whale',
      displayName: 'WhaleAlert42', platform: 'discord', platformHandle: 'WhaleAlert42',
      attributes: { project: 'NightOwl Protocol' },
    },
    {
      id: 'ent_w2', canonicalPerson: 'whale',
      displayName: 'nightowl_dev', platform: 'twitter', platformHandle: '@nightowl_dev',
      attributes: { project: 'NightOwl Protocol' },
    },

    // ── Alice Rivera: Discord + Twitter ──────
    // Resolution: EASY — self-reports twitter handle in Discord
    {
      id: 'ent_a1', canonicalPerson: 'alice',
      displayName: 'alice_mod', platform: 'discord', platformHandle: 'alice_mod',
      attributes: { role: 'admin' },
    },
    {
      id: 'ent_a2', canonicalPerson: 'alice',
      displayName: 'alice_web3', platform: 'twitter', platformHandle: '@alice_web3',
      attributes: { role: 'community lead' },
    },

    // ── Single-platform entities ─────────────
    {
      id: 'ent_s1', canonicalPerson: 'sarah',
      displayName: 'sarahc.eth', platform: 'discord', platformHandle: 'sarahc.eth',
      attributes: { occupation: 'frontend dev' },
    },
    {
      id: 'ent_b1', canonicalPerson: 'bob',
      displayName: 'bobk', platform: 'discord', platformHandle: 'bobk',
      attributes: { occupation: 'backend dev' },
    },
    {
      id: 'ent_e1', canonicalPerson: 'eve',
      displayName: 'TotallyLegit_Admin', platform: 'discord', platformHandle: 'TotallyLegit_Admin',
      attributes: { intent: 'malicious' },
    },
    {
      id: 'ent_m1', canonicalPerson: 'marcus',
      displayName: 'marcus_dev', platform: 'discord', platformHandle: 'marcus_dev',
      attributes: { occupation: 'junior dev' },
    },
    {
      id: 'ent_p1', canonicalPerson: 'priya',
      displayName: 'priya_ships', platform: 'twitter', platformHandle: '@priya_ships',
      attributes: { occupation: 'PM' },
    },
    {
      id: 'ent_x1', canonicalPerson: 'alex_designer',
      displayName: 'alexr_design', platform: 'discord', platformHandle: 'alexr_design',
      attributes: { occupation: 'UI designer', location: 'SF' },
    },
    {
      id: 'ent_x2', canonicalPerson: 'alex_engineer',
      displayName: 'petrovalex', platform: 'discord', platformHandle: 'petrovalex',
      attributes: { occupation: 'distributed systems', location: 'London' },
    },
    {
      id: 'ent_j1', canonicalPerson: 'jordan',
      displayName: 'j0rdan_nft', platform: 'discord', platformHandle: 'j0rdan_nft',
      attributes: {},
    },
  ],

  links: [
    {
      entityA: 'ent_d1', entityB: 'ent_d2', difficulty: 'medium',
      reason: 'd4v3_builds (Discord) + chaintrack3r (Twitter): both share github.com/davebuilds and project ChainTracker',
      expectedSignals: ['shared_github_handle:davebuilds', 'shared_project:ChainTracker'],
    },
    {
      entityA: 'ent_a1', entityB: 'ent_a2', difficulty: 'easy',
      reason: 'alice_mod (Discord) self-reports twitter @alice_web3',
      expectedSignals: ['self_reported_handle:@alice_web3'],
    },
    {
      entityA: 'ent_w1', entityB: 'ent_w2', difficulty: 'hard',
      reason: 'WhaleAlert42 (Discord) verbally confirms being @nightowl_dev (Twitter). NO handle overlap.',
      expectedSignals: ['verbal_self_identification:@nightowl_dev'],
    },
  ],

  antiLinks: [
    { entityA: 'ent_x1', entityB: 'ent_x2', reason: 'Different people named Alex — different occupations, locations, handles' },
    { entityA: 'ent_e1', entityB: 'ent_a1', reason: 'Eve falsely claims to be Alice — adversarial' },
    { entityA: 'ent_e1', entityB: 'ent_a2', reason: 'Eve falsely claims to be Alice — adversarial' },
  ],
};
