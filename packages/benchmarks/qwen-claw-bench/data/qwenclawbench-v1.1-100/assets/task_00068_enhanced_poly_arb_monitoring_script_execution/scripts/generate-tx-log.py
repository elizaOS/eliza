import random
import datetime

random.seed(42)

statuses = ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "FAILED", "PENDING"]
dexes = ["quickswap", "sushiswap", "uniswap_v3"]
pairs = ["POL/USDC", "WETH/USDC", "POL/WETH"]
fail_reasons = ["INSUFFICIENT_OUTPUT", "DEADLINE_EXCEEDED", "SLIPPAGE_TOO_HIGH", "GAS_ESTIMATION_FAILED", "NONCE_TOO_LOW"]

base_time = datetime.datetime(2026, 2, 10, 6, 0, 0)  # start at 06:00 UTC (14:00 Shanghai)
lines = []

for i in range(85):
    offset_min = random.randint(0, 960)  # spread over ~16 hours
    ts = base_time + datetime.timedelta(minutes=offset_min, seconds=random.randint(0, 59))
    status = random.choice(statuses)
    pair = random.choice(pairs)
    dex_a = random.choice(dexes)
    dex_b = random.choice([d for d in dexes if d != dex_a])
    
    tx_hash = "0x" + "".join(random.choices("0123456789abcdef", k=64))
    
    if pair == "POL/USDC":
        amount_in = round(random.uniform(100, 3000), 2)
        amount_out = round(amount_in * random.uniform(0.38, 0.42), 2)
        token_in, token_out = "POL", "USDC"
    elif pair == "WETH/USDC":
        amount_in = round(random.uniform(0.1, 2.5), 4)
        amount_out = round(amount_in * random.uniform(2600, 2750), 2)
        token_in, token_out = "WETH", "USDC"
    else:
        amount_in = round(random.uniform(500, 5000), 2)
        amount_out = round(amount_in * random.uniform(0.000145, 0.000155), 6)
        token_in, token_out = "POL", "WETH"

    slippage = random.randint(1, 80) if status == "SUCCESS" else random.randint(30, 120)
    gas_used = random.randint(120000, 450000)
    gas_price_gwei = round(random.uniform(25, 180), 1)
    profit_usdc = round(random.uniform(-0.50, 3.20), 4) if status == "SUCCESS" else 0.0
    
    reason = ""
    if status == "FAILED":
        reason = f" reason={random.choice(fail_reasons)}"
    
    line = (
        f"{ts.strftime('%Y-%m-%dT%H:%M:%SZ')} "
        f"{status:8s} "
        f"pair={pair:10s} "
        f"route={dex_a}->{dex_b:12s} "
        f"in={amount_in} {token_in:5s} "
        f"out={amount_out} {token_out:5s} "
        f"slippage_bps={slippage:3d} "
        f"gas={gas_used} "
        f"gasPrice={gas_price_gwei}gwei "
        f"profit={profit_usdc:+.4f}USDC "
        f"tx={tx_hash}"
        f"{reason}"
    )
    lines.append((ts, line))

lines.sort(key=lambda x: x[0])

with open("/home/node/workspace/logs/transactions.log", "w") as f:
    for _, line in lines:
        f.write(line + "\n")

print(f"Generated {len(lines)} transaction log entries")
