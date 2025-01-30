# system: debian11
# required: jq, tmux, pnpm

# you can uncomment above if using openai provider
OPENAI_API_KEY="$OPENAI_API_KEY"
# if no apikey provided, the endpoint may be not working
TON_RPC_API_KEY="$TON_RPC_API_KEY"

apt install -y jq tmux

grep 'const importedPlugin = await import("@elizaos/plugin-ton");' agent/src/index.ts
if [ $? -eq 0 ]; then
    echo "already patched"
else
    # insert tonplugin as default plugin for the default character
    if [ -z "$OPENAI_API_KEY" ]; then
        sed -i '/let characters = \[defaultCharacter\];/a \
    const importedPlugin = await import("@elizaos/plugin-ton");\
    defaultCharacter.plugins = [importedPlugin.default];\
    // defaultCharacter.modelProvider = ModelProviderName.OPENAI;' agent/src/index.ts
    else
        sed -i '/let characters = \[defaultCharacter\];/a \
    const importedPlugin = await import("@elizaos/plugin-ton");\
    defaultCharacter.plugins = [importedPlugin.default];\
    defaultCharacter.modelProvider = ModelProviderName.OPENAI;' agent/src/index.ts
    fi
fi

# check the content
grep -C 4 'let characters = ' agent/src/index.ts

# add below to the root package.json to fix https://github.com/elizaOS/eliza/issues/1965
jq '. + { "resolutions": { "agent-twitter-client": "github:timmyg/agent-twitter-client#main" } }' package.json  > tmp.json && mv tmp.json package.json

pnpm install --no-frozen-lockfile

# generate ton private key if you do not have one
# pnpm --dir packages/plugin-ton mnemonic

pnpm build

TON_RPC_URL="https://testnet.toncenter.com/api/v2/jsonRPC"
TON_PRIVATE_KEY="demise portion caught unit slot patient pumpkin second faint surround vote awkward afraid turtle extra donate core auction share arrest spend maid say chuckle"

# stop the server if it is running
tmux kill-session -t client && tmux kill-session -t agent || true

# start client
tmux new -s client -d \
"export TON_RPC_URL='$TON_RPC_URL' && export TON_PRIVATE_KEY='$TON_PRIVATE_KEY' && \
export OPENAI_API_KEY='$OPENAI_API_KEY' && export TON_RPC_API_KEY=$TON_RPC_API_KEY && pnpm --dir client dev -- --host"
# start agent using the default character
tmux new -s agent -d \
"export TON_RPC_URL='$TON_RPC_URL' && export TON_PRIVATE_KEY='$TON_PRIVATE_KEY' && \
export OPENAI_API_KEY='$OPENAI_API_KEY' && export TON_RPC_API_KEY='$TON_RPC_API_KEY' && echo '$TON_PRIVATE_KEY' && env && pnpm --dir agent dev --"

# check the status
tmux ls

echo '
- you can check balance and transfer on https://testnet.tonviewer.com/kQDT62Zxkrlj-NG9cODSAfRzuNYrSbrtVVAnjHfK7lvs4Rp1
- you should get testcoin from https://t.me/testgiver_ton_bot, the address is: `UQDT62Zxkrlj-NG9cODSAfRzuNYrSbrtVVAnjHfK7lvs4fw6`
- open the browser, go to http://localhost:5173/ and select one chat to start
- send `hello`` and wait for it have been initialized
- send `Send 0.3 TON tokens to EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4` to test the transfer
- `tmux kill-session -t client && tmux kill-session -t agent` to stop the server
- `tmux a -t client` to watch the client logs, `tmux a -t agent` to watch the agent logs
'
