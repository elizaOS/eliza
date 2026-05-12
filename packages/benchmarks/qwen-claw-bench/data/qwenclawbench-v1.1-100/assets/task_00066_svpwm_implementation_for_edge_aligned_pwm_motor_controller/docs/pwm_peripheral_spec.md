# PWM Peripheral Specification — XMC4200 Motor Control Unit

## Document Revision
- **Rev:** 2.3
- **Date:** 2024-01-15
- **Status:** Released

## 1. Overview

The PWM module (CCU8) provides three independent output channels suitable for driving a three-phase voltage source inverter. Each channel has an independent compare register and supports dead-time insertion.

## 2. Operating Mode: Edge-Aligned (Sawtooth)

The PWM module is configured in **edge-aligned mode**. The timer counter operates as a free-running sawtooth:

```
Counter behavior:
  - Counts UP from 0 to PWM_PERIOD (1000)
  - Resets to 0 on overflow
  - One PWM cycle = one count from 0 to PWM_PERIOD

        PWM_PERIOD (1000) ─┐     ┌─────
                           │    /│    /
                           │   / │   /
                           │  /  │  /
                           │ /   │ /
                     0 ────┘/    └/─────
                           |<--->|
                           Ts = 1/f_pwm
```

**Important:** This is NOT center-aligned (triangle/up-down) mode. The counter does NOT count down. It counts from 0 to PWM_PERIOD and resets.

## 3. Compare Register and Output Logic

Each channel has a 16-bit compare register (`CMP_x` where x = U, V, W).

**Output logic:**
```
When counter < CMP_x:  Output = HIGH (transistor ON)
When counter >= CMP_x: Output = LOW  (transistor OFF)
```

**Duty cycle formula:**
```
Duty_cycle = CMP_x / PWM_PERIOD
```

Where:
- `CMP_x` range: 0 to PWM_PERIOD (0 to 1000)
- `CMP_x = 0` → 0% duty (always LOW)
- `CMP_x = 500` → 50% duty
- `CMP_x = 1000` → 100% duty (always HIGH)

## 4. PWM Parameters

| Parameter          | Value  | Unit   |
|--------------------|--------|--------|
| PWM_PERIOD         | 1000   | counts |
| PWM Frequency      | 20,000 | Hz     |
| Clock Frequency    | 20 MHz | Hz     |
| Compare Range      | 0–1000 | counts |
| Resolution         | 0.1%   | —      |
| Dead Time (min)    | 500    | ns     |
| Dead Time (max)    | 5000   | ns     |

## 5. Channel Assignment

| Channel | Function     | Pin    | Compare Register |
|---------|-------------|--------|------------------|
| CH0     | Phase U (A) | P0.0   | CMP_U            |
| CH1     | Phase V (B) | P0.1   | CMP_V            |
| CH2     | Phase W (C) | P0.2   | CMP_W            |

## 6. Dead Time Insertion

Dead time is inserted automatically by the hardware between the high-side and low-side gate signals. The dead time value is configured in the `DT_RISE` and `DT_FALL` registers.

```
Dead time = DT_value × (1 / Clock_Frequency)
For 500 ns: DT_value = 500ns × 20MHz = 10 counts
```

## 7. Update Mechanism

Compare registers are shadow-buffered. New values written to the shadow registers are transferred to the active registers at the next period boundary (counter overflow from PWM_PERIOD to 0).

```
Write CMP_U_shadow → transferred at next counter=0 event
```

This ensures glitch-free updates.

## 8. Interrupt Sources

| Interrupt        | Trigger Condition       |
|------------------|------------------------|
| Period Match     | Counter = PWM_PERIOD   |
| Zero Match       | Counter = 0            |
| Compare Match U  | Counter = CMP_U        |
| Compare Match V  | Counter = CMP_V        |
| Compare Match W  | Counter = CMP_W        |

For SVPWM, the **Period Match** interrupt is typically used to trigger the next duty cycle calculation.

## 9. Edge-Aligned vs Center-Aligned — Key Differences

| Feature                | Edge-Aligned (THIS MCU) | Center-Aligned        |
|------------------------|-------------------------|-----------------------|
| Counter mode           | Sawtooth (up only)      | Triangle (up-down)    |
| Period value           | PWM_PERIOD              | PWM_PERIOD/2          |
| Duty base              | PWM_PERIOD              | PWM_PERIOD/2          |
| T0 distribution        | T0/2 + active + T0/2   | T0/4 + ... + T0/4     |
| Switching per period   | 1 transition per phase  | 2 transitions/phase   |
| Natural symmetry       | No                      | Yes                   |

**Warning:** Do not use center-aligned duty cycle formulas with this edge-aligned peripheral. The T0 zero-vector distribution is fundamentally different.
