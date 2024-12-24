symbol = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'

address = '4wgfCBf2WwLSRKLef9iW7JXZ2AfkxUxGM4XcKpHm3Sin'

usd_size = 5 # this is the size of the position we want to hold
max_usd_order_size = 1 # this is the max size of the order we can send
tx_sleep = 30 # this is the sleep time between transactions
slippage = 199 # this is the slippage we want to use

# for entering & closing, solana is tricky. so we have slippage, priority fee, and orders_per_open if spamming orders is needed
slippage = 199 # 50% slippage, so 500 = 5% and 50 = .5% slippage
PRIORITY_FEE = 100000 # 200000 is about .035 usd at 150 sol, after a bit of testing 100000 is sufficient and is .02 usd
orders_per_open = 3 # as orders are hard to get through, we can send multiple

# this is for ezbot buy under/sell over function call #5
buy_under = .0946
sell_over = 1

# this is for ezbot sell under/buy over function call #2
STOPLOSS_PRICE = 1

# this is the price the ai would buy over for a breakout. call #3
BREAKOUT_PRICE = .0001

# to prevent over trading, after closing a position sleep for X seconds
SLEEP_AFTER_CLOSE = 600

# action #4 - get OHLCV data
DAYSBACK_4_DATA = 10
DATA_TIMEFRAME = '15m'


# ignore - these are variables that dont do anything yet
sell_at_multiple = 3
USDC_SIZE = 1
limit = 49
timeframe = '15m'
stop_loss_perctentage = -.24
tokens_to_trade = ['777']
EXIT_ALL_POSITIONS = False
DO_NOT_TRADE_LIST = ['777']
CLOSED_POSITIONS_TXT = '777'
minimum_trades_in_last_hour = 777