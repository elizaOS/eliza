---
name: dialogue-graph
description: A library for building, validating, visualizing, and serializing dialogue graphs. Use this when parsing scripts or creating branching narrative structures.
---

# Dialogue Graph Skill

This skill provides a `dialogue_graph` module to easily build valid dialogue trees/graphs.

## When to use

*   **Script Parsers**: When converting text to data.
*   **Dialogue Editors**: When building tools to edit conversation flow.
*   **Game Logic**: When traversing a dialogue tree.
*   **Visualization**: When generating visual diagrams of dialogue flows.

## How to use

Import the module:
```python
from dialogue_graph import Graph, Node, Edge
```

### 1. The `Graph` Class
The main container.

```python
graph = Graph()
```

### 2. Adding Nodes
Define content nodes.

```python
# Regular line
graph.add_node(Node(id="Start", speaker="Guard", text="Halt!", type="line"))

# Choice hub
graph.add_node(Node(id="Choices", type="choice"))
```

### 3. Adding Edges
Connect nodes (transitions).

```python
# Simple transition
graph.add_edge(Edge(source="Start", target="Choices"))

# Choice transition (with text)
graph.add_edge(Edge(source="Choices", target="End", text="1. Run away"))
```

### 4. Export
Serialize to JSON format for the engine.

```python
data = graph.to_dict()
# returns {"nodes": [...], "edges": [...]}
json_str = graph.to_json()
```

### 5. Validation
Check for integrity.

```python
errors = graph.validate()
# Returns list of strings, e.g., ["Edge 'Start'->'Unk' points to missing node 'Unk'"]
```

### 6. Visualization
Generate a PNG/SVG graph diagram.

```python
# Requires: pip install graphviz
# Also requires Graphviz binary: https://graphviz.org/download/

graph.visualize('dialogue_graph')  # Creates dialogue_graph.png
graph.visualize('output', format='svg')  # Creates output.svg
```

The visualization includes:
- **Diamond shapes** for choice nodes (light blue)
- **Rounded boxes** for dialogue nodes (colored by speaker)
- **Bold blue edges** for skill-check choices like `[Lie]`, `[Attack]`
- **Gray edges** for regular choices
- **Black edges** for simple transitions

### 7. Loading from JSON
Load an existing dialogue graph.

```python
# From file
graph = Graph.from_file('dialogue.json')

# From dict
graph = Graph.from_dict({'nodes': [...], 'edges': [...]})

# From JSON string
graph = Graph.from_json(json_string)
```
