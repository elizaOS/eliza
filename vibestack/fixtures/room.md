# Room

A room has two lamps. Each lamp is a machine in its own right, with its own
rules; the room uses it under the name `L` and adds rules about the pair.

## Story: Light a room

### A room has a left and a right lamp, and starts dark

```quint
import lamp as L from "./lamp"

type Room = { left: L::Lamp, right: L::Lamp, switched: int }

pure val initial: Room = { left: L::initial, right: L::initial, switched: 0 }
```

### Either lamp can be switched, and the room counts every switch

```quint
pure def toggleLeft(r: Room): Room = { ...r, left: L::toggle(r.left), switched: r.switched + 1 }
pure def toggleRight(r: Room): Room = { ...r, right: L::toggle(r.right), switched: r.switched + 1 }

pure def alwaysEachLampKeepsItsOwnRules(r: Room): bool =
  L::alwaysFlipsAreCounted(r.left) and L::alwaysAnUnusedLampIsOff(r.left)
    and L::alwaysFlipsAreCounted(r.right) and L::alwaysAnUnusedLampIsOff(r.right)

pure def alwaysTheRoomCountsWhatTheLampsCount(r: Room): bool =
  r.switched == r.left.flips + r.right.flips

pure def stepOneSwitchMovesOneLamp(before: Room, after: Room): bool =
  after.switched == before.switched + 1

pure def sometimesFullyLit(r: Room): bool = r.left.mode == L::On and r.right.mode == L::On
```
