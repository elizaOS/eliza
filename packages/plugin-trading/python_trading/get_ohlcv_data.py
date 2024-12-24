import nice_funcs as n

token_contract_address = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'
number_of_days_of_data = 10
data_timeframe = '15m'

print('OHLCV data bot')
df = n.get_data(token_contract_address, number_of_days_of_data, data_timeframe)

# save df to csv here packages/plugin-trading/python_trading/ohlcv_data
df.to_csv(f'packages/plugin-trading/python_trading/ohlcv_data/{token_contract_address}.csv')