# Valhalla self-repair

Self-repair is part of the agent. It is not only a restart button.

## Layer 1, always on

These steps run without a confirm tap.

- Every network stage has a deadline. A hung call times out.
- The next price or RPC provider is used when the current one fails or is rate limited.
- A circuit breaker opens after repeated failures and pauses new buys.
- On-chain reads are the truth for positions, balances, and signatures. A failed read is unknown. It is never stored as zero.
- A signature is remembered. If a send times out and then lands, a second send of that signature is blocked.
- A crash restart runs only when no position is open and nothing is in flight.
- A health score from 0 to 100 is shown on the desk and the phone.

## Layer 2, a written diagnosis

The agent reads recent logs and writes a short incident report. Gemini can phrase it when a Google AI Studio key is set. The allowed fixes are only:

- switch provider
- raise a timeout, between 1 and 20 seconds
- pause new buys
- reconnect
- restart when nothing is open and nothing is in flight
- a settings change that stays inside the existing bounds

A code change is never applied. At most it is staged as text for a person to review in a pull request.

Config changes and restarts wait for Confirm repair on the desk or the phone. The agent cannot touch keys, turn safety checks off, loosen a stop, or send or withdraw funds.

## Where you see it

Controls on the desk has Self-Repair Log. Each line shows health before and after. The phone status line includes the health score.
