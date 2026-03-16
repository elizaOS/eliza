# elizaos-plugin-eliza-classic

Python implementation of the Classic ELIZA pattern matching plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-eliza-classic
```

## Usage

```python
from elizaos_plugin_eliza_classic import ElizaClassicPlugin

plugin = ElizaClassicPlugin()

# Generate a response
response = plugin.generate_response("I feel sad today")
print(response)  # => "I am sorry to hear that you are feeling that way."

# Get the greeting
greeting = plugin.get_greeting()
print(greeting)  # => "Hello. I am ELIZA..."
```

## License

MIT



