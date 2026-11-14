# Lamp

## Story: Switch a lamp

### A lamp is on or off, and counts how often it was switched

```quint
type Mode = On | Off
type Lamp = { mode: Mode, flips: int }

pure val initial: Lamp = { mode: Off, flips: 0 }

pure def toggle(l: Lamp): Lamp = { mode: if (l.mode == On) Off else On, flips: l.flips + 1 }

pure def alwaysFlipsAreCounted(l: Lamp): bool = l.flips >= 0
pure def alwaysAnUnusedLampIsOff(l: Lamp): bool = l.flips == 0 implies l.mode == Off
pure def sometimesOn(l: Lamp): bool = l.mode == On
```
