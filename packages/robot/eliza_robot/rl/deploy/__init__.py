"""Deployment harnesses — policy runtime and CLI entrypoints.

Each script honours the standard flag set:

``--bridge ws://localhost:9100``
    Websocket bridge URL.
``--checkpoint <path>``
    Override the Brax checkpoint directory.
``--duration <seconds>``
    Maximum run time before the harness sends a standing pose and exits.
``--profile hiwonder-ainex``
    Robot profile id (defaults to the bundled Hiwonder AiNex profile).
"""
