/**
 * The token amounts that a V3 position's liquidity is worth at the pool's
 * current price. Uniswap v3-core TickMath.getSqrtRatioAtTick and v3-periphery
 * LiquidityAmounts.getAmountsForLiquidity; PancakeSwap V3 uses the same math.
 */

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

// The ratio factors for tick bits 0x2 to 0x80000, from TickMath.sol.
const TICK_FACTORS = [
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

function sqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  let ratio = absTick & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  TICK_FACTORS.forEach((factor, index) => {
    if (absTick & (2n << BigInt(index))) ratio = (ratio * factor) >> 128n;
  });
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export function positionAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number
): { amount0: bigint; amount1: bigint } {
  const lower = sqrtRatioAtTick(tickLower);
  const upper = sqrtRatioAtTick(tickUpper);
  const amount0 = (from: bigint) => ((liquidity << 96n) * (upper - from)) / upper / from;
  const amount1 = (to: bigint) => (liquidity * (to - lower)) / Q96;
  if (sqrtPriceX96 <= lower) return { amount0: amount0(lower), amount1: 0n };
  if (sqrtPriceX96 < upper)
    return { amount0: amount0(sqrtPriceX96), amount1: amount1(sqrtPriceX96) };
  return { amount0: 0n, amount1: amount1(upper) };
}
