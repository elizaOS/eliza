# Eliza Plugin Simple Voice (Python)

Python implementation of the SAM Text-to-Speech plugin.

## Installation

```bash
pip install -e .
```

## Usage

```python
from eliza_plugin_simple_voice import SamTTSService, SamTTSOptions

service = SamTTSService()
audio = service.generate_audio("Hello", SamTTSOptions(speed=72))
wav = service.create_wav_buffer(audio)
```

## Testing

```bash
pytest
```
