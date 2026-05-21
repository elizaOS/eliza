# Manual review — login

Route: `/login`

Screenshots: `../desktop/login.png`, `../desktop/login--hover.png`, `../mobile/login.png`

## Verdict

`good` — sign-in card is clean, no blue, orange Passkey CTA reads as primary.

## Visual issues

- Sign-in card hugs upper-middle with significant whitespace below; consider vertical centring or a brand graphic in the lower half.
- "Sign in" + "Run Eliza in Cloud" headings feel slightly redundant.

## Interaction targets for e2e

- Magic Link submit empty/invalid email error toast.
- Ethereum/Solana buttons → covered by siwe-flow/solana-login specs.
- Passkey button → invoke WebAuthn (puppeteer virtual authenticator); not currently covered.
