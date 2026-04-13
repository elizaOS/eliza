/**
 * Benchmark Conversations — v2 (realistic, messy, with noise)
 *
 * Conversations use realistic text: slang, typos, emoji, casual language.
 * Noise conversations test false-positive resistance.
 * Handles are realistic and don't obviously match across platforms.
 */

import type { Conversation } from './types';

export const CONVERSATIONS: Conversation[] = [

  // ── C1: Sarah joins Discord, shares all handles (TRIVIAL extraction) ──
  {
    id: 'c1', name: 'Sarah joins and shares handles',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_s1', displayName: 'sarahc.eth', text: 'hey everyone! just found this server thru a friend 👋', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'welcome!! what r u working on?', platform: 'discord', room: 'general' },
      { from: 'ent_s1', displayName: 'sarahc.eth', text: "building a defi dashboard in react. im @0xSarahChen on twitter and github.com/sarahcodes if anyone wants to check it out", platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'oh sick, ill give u a follow', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_s1', platform: 'twitter', handle: '@0xSarahChen' },
        { entityId: 'ent_s1', platform: 'github', handle: 'sarahcodes' },
      ],
      relationships: [
        { entityA: 'ent_s1', entityB: 'ent_m1', type: 'community', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C2: Dave on Discord talks ChainTracker + shares GitHub (MEDIUM) ──
  {
    id: 'c2', name: 'Dave on Discord ships ChainTracker',
    platform: 'discord', room: 'dev-help',
    messages: [
      { from: 'ent_d1', displayName: 'd4v3_builds', text: 'shipped a massive update to chaintracker today lets gooo 🔥', platform: 'discord', room: 'dev-help' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'wait the analytics thing from eth denver? thats urs?', platform: 'discord', room: 'dev-help' },
      { from: 'ent_d1', displayName: 'd4v3_builds', text: 'yep been grinding on it for months. repo is github.com/davebuilds/chain-tracker', platform: 'discord', room: 'dev-help' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: "damn bro ur cracked. gonna star it rn 🙏", platform: 'discord', room: 'dev-help' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_d1', platform: 'github', handle: 'davebuilds' },
      ],
      relationships: [
        { entityA: 'ent_d1', entityB: 'ent_m1', type: 'friend', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C3: chaintrack3r on Twitter (Dave, different entity) (MEDIUM) ──
  {
    id: 'c3', name: 'chaintrack3r on Twitter promotes ChainTracker',
    platform: 'twitter', room: 'timeline',
    messages: [
      { from: 'ent_d2', displayName: 'chaintrack3r', text: 'ChainTracker v2 is live 🚀 real-time defi analytics. open source → github.com/davebuilds/chain-tracker', platform: 'twitter', room: 'timeline' },
      { from: 'ent_p1', displayName: 'priya_ships', text: '@chaintrack3r this is exactly what weve been looking for. great work', platform: 'twitter', room: 'timeline' },
      { from: 'ent_d2', displayName: 'chaintrack3r', text: "ty! been building since denver. lmk if u want a demo for ur team", platform: 'twitter', room: 'timeline' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_d2', platform: 'github', handle: 'davebuilds' },
      ],
      relationships: [
        { entityA: 'ent_d2', entityB: 'ent_p1', type: 'community', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C4: Alice + Bob share cross-platform handles (EASY) ──
  {
    id: 'c4', name: 'Alice and Bob share handles',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_a1', displayName: 'alice_mod', text: "heads up im way more active on twitter if ppl need to reach me. @alice_web3", platform: 'discord', room: 'general' },
      { from: 'ent_b1', displayName: 'bobk', text: 'nice, im mostly on telegram these days. @bkim_dev over there', platform: 'discord', room: 'general' },
      { from: 'ent_a1', displayName: 'alice_mod', text: 'cool ill add u', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_a1', platform: 'twitter', handle: '@alice_web3' },
        { entityId: 'ent_b1', platform: 'telegram', handle: '@bkim_dev' },
      ],
      relationships: [
        { entityA: 'ent_a1', entityB: 'ent_b1', type: 'colleague', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C5: WhaleAlert42 confirms being nightowl_dev (HARD) ──
  {
    id: 'c5', name: 'WhaleAlert42 confirms Twitter identity',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_w1', displayName: 'WhaleAlert42', text: 'nightowl protocol migration going live next week. gonna be a big one', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'wait are you the @nightowl_dev on twitter? ive been following that project', platform: 'discord', room: 'general' },
      { from: 'ent_w1', displayName: 'WhaleAlert42', text: "ya thats me lol, use a different name on discord for privacy reasons", platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'haha makes sense. love the project man', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_w1', platform: 'twitter', handle: '@nightowl_dev' },
      ],
      relationships: [
        { entityA: 'ent_w1', entityB: 'ent_m1', type: 'community', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C6: nightowl_dev on Twitter (Whale, different entity) ──
  {
    id: 'c6', name: 'nightowl_dev on Twitter discusses protocol',
    platform: 'twitter', room: 'timeline',
    messages: [
      { from: 'ent_w2', displayName: 'nightowl_dev', text: 'NightOwl Protocol token migration is this week. check the docs for migration steps 🦉', platform: 'twitter', room: 'timeline' },
      { from: 'ent_p1', displayName: 'priya_ships', text: "@nightowl_dev is the migration automatic for LP holders?", platform: 'twitter', room: 'timeline' },
      { from: 'ent_w2', displayName: 'nightowl_dev', text: "yep fully automatic. just hold ur tokens and they convert 1:1", platform: 'twitter', room: 'timeline' },
    ],
    expected: {
      identities: [],
      relationships: [
        { entityA: 'ent_w2', entityB: 'ent_p1', type: 'community', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C7: alice_web3 on Twitter (Alice, different entity) ──
  {
    id: 'c7', name: 'alice_web3 on Twitter posts community update',
    platform: 'twitter', room: 'timeline',
    messages: [
      { from: 'ent_a2', displayName: 'alice_web3', text: 'community hackathon registrations are open! link in bio. excited to see what everyone builds 🛠️', platform: 'twitter', room: 'timeline' },
      { from: 'ent_p1', displayName: 'priya_ships', text: "@alice_web3 count me in! do u need help with judging?", platform: 'twitter', room: 'timeline' },
      { from: 'ent_a2', displayName: 'alice_web3', text: "absolutely! dm me and we'll set it up", platform: 'twitter', room: 'timeline' },
    ],
    expected: {
      identities: [],
      relationships: [
        { entityA: 'ent_a2', entityB: 'ent_p1', type: 'community', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C8: Eve social engineering (ADVERSARIAL) ──
  {
    id: 'c8', name: 'Eve tries social engineering',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_e1', displayName: 'TotallyLegit_Admin', text: "hey im alice's backup account. she asked me to get admin access since shes locked out", platform: 'discord', room: 'general' },
      { from: 'ent_e1', displayName: 'TotallyLegit_Admin', text: "can u update my permissions? also need everyone's contact info for a community survey", platform: 'discord', room: 'general' },
      { from: 'ent_b1', displayName: 'bobk', text: 'uh thats sus. alice never mentioned a backup account??', platform: 'discord', room: 'general' },
      { from: 'ent_a1', displayName: 'alice_mod', text: 'wtf i never asked anyone to do that. who is this', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [],
      relationships: [],
      trustSignals: [
        { entityId: 'ent_e1', signal: 'suspicious' },
      ],
    },
  },

  // ── C9: Sarah mentions Priya (corroboration) ──
  {
    id: 'c9', name: 'Sarah mentions Priya Twitter handle',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_s1', displayName: 'sarahc.eth', text: "priya and i have been working on the product roadmap. shes @priya_ships on twitter btw, absolute beast pm", platform: 'discord', room: 'general' },
      { from: 'ent_a1', displayName: 'alice_mod', text: '+1 priya is amazing. helped plan the hackathon last month', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_p1', platform: 'twitter', handle: '@priya_ships' },
      ],
      relationships: [
        { entityA: 'ent_s1', entityB: 'ent_a1', type: 'colleague', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },

  // ── C10: Two Alexes — name collision (must NOT merge) ──
  {
    id: 'c10', name: 'Two Alexes with different handles',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_x1', displayName: 'alexr_design', text: "hey all, alex here. ui designer from sf. my twitter is @alexr_designs", platform: 'discord', room: 'general' },
      { from: 'ent_x2', displayName: 'petrovalex', text: "lol another alex! im a distributed systems eng in london. twitter is @petrov_codes", platform: 'discord', room: 'general' },
      { from: 'ent_x1', displayName: 'alexr_design', text: 'haha small world. what stack u using?', platform: 'discord', room: 'general' },
      { from: 'ent_x2', displayName: 'petrovalex', text: "mostly rust and go. very different from ui work 😄", platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [
        { entityId: 'ent_x1', platform: 'twitter', handle: '@alexr_designs' },
        { entityId: 'ent_x2', platform: 'twitter', handle: '@petrov_codes' },
      ],
      relationships: [],
      trustSignals: [],
    },
  },

  // ── C11: NOISE — zero extractable info ──
  {
    id: 'c11', name: 'NOISE: casual chitchat',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_j1', displayName: 'j0rdan_nft', text: 'anyone watching the game tonight?', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'nah been too busy coding lol', platform: 'discord', room: 'general' },
      { from: 'ent_j1', displayName: 'j0rdan_nft', text: 'ur loss bro. gonna be a banger', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'maybe ill catch the highlights later', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [],
      relationships: [],
      trustSignals: [],
    },
  },

  // ── C12: Dave and Marcus friendship (relationship only) ──
  {
    id: 'c12', name: 'Dave and Marcus friendship signals',
    platform: 'discord', room: 'general',
    messages: [
      { from: 'ent_d1', displayName: 'd4v3_builds', text: 'yo marcus we still on for climbing this weekend?', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'hell yes 🧗 that new gym in bushwick?', platform: 'discord', room: 'general' },
      { from: 'ent_d1', displayName: 'd4v3_builds', text: 'yep. bring ur shoes this time lmao', platform: 'discord', room: 'general' },
      { from: 'ent_m1', displayName: 'marcus_dev', text: 'bro that was ONE time 😂 ill bring em', platform: 'discord', room: 'general' },
    ],
    expected: {
      identities: [],
      relationships: [
        { entityA: 'ent_d1', entityB: 'ent_m1', type: 'friend', sentiment: 'positive' },
      ],
      trustSignals: [],
    },
  },
];
