# Switch

A push switch that drives a lamp. Pressing it does nothing to the light;
releasing it toggles the light. As far as the light goes, the switch is the
lamp of `lamp.md`, and every rule of the lamp carries over to it.

## Story: Press a switch

### A switch is lit or not, counts its presses, and starts released and dark

```quint
import lamp as L from "./lamp"

type Switch = { lit: bool, presses: int, held: bool }

pure val initial: Switch = { lit: false, presses: 0, held: false }
```

### Seen as a lamp, a switch is on when lit and has flipped once per press

```quint
pure def refinesL(s: Switch): L::Lamp = { mode: if (s.lit) L::On else L::Off, flips: s.presses }
```

### Pressing holds the switch down, and releasing it toggles the light

```quint
pure def canPress(s: Switch): bool = not(s.held)
pure def press(s: Switch): Switch = { ...s, held: true }
pure def canToggle(s: Switch): bool = s.held
pure def toggle(s: Switch): Switch = { lit: not(s.lit), presses: s.presses + 1, held: false }
pure def sometimesLit(s: Switch): bool = s.lit
```
