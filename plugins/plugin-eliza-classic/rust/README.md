# elizaos-plugin-eliza-classic

Rust implementation of the Classic ELIZA pattern matching plugin for elizaOS.

## Installation

```toml
[dependencies]
elizaos-plugin-eliza-classic = "1.0"
```

## Usage

```rust
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;

fn main() {
    let plugin = ElizaClassicPlugin::new();

    // Generate a response
    let response = plugin.generate_response("I feel sad today");
    println!("{}", response);

    // Get the greeting
    let greeting = plugin.get_greeting();
    println!("{}", greeting);
}
```

## License

MIT



