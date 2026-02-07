# Property-Based Testing

Property-based testing guidance for multiple languages and smart contracts.

## Installation

This plugin is part of the Trail of Bits Skills marketplace.

### Via Marketplace (Recommended)

```
/plugin marketplace add trailofbits/skills
/plugin menu
```

Then select the `property-based-testing` plugin to install.

### Manual Installation

```
/plugin install trailofbits/skills/plugins/property-based-testing
```

## What's Included

This plugin provides a skill that helps Claude Code proactively suggest and write property-based tests when it detects suitable patterns in your code:

- **Serialization pairs**: encode/decode, serialize/deserialize, toJSON/fromJSON
- **Parsers**: URL parsing, config parsing, protocol parsing
- **Normalization**: normalize, sanitize, clean, canonicalize
- **Validators**: is_valid, validate, check_*
- **Data structures**: Custom collections with add/remove/get operations
- **Mathematical/algorithmic**: Pure functions, sorting, ordering
- **Smart contracts**: Solidity/Vyper contracts, token operations, state invariants

## Supported Languages

- Python (Hypothesis)
- JavaScript/TypeScript (fast-check)
- Rust (proptest, quickcheck)
- Go (rapid, gopter)
- Java (jqwik)
- Scala (ScalaCheck)
- Solidity/Vyper (Echidna, Medusa)
- And many more...

See `skills/property-based-testing/references/libraries.md` for the complete list.
