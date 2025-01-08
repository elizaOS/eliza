import {
    ChannelListResponse,
    GetNodeInfoResponse,
    GetNodeInfoResponseNumberKeys, PaymentResponse,
    UdtArgInfoNumberKeys,
} from "./types.ts";
import {convert} from "./rpcClient.ts";
import {SupportedUDTs, CKBDecimal} from "../../constants.ts";
import {cccClient} from "../ccc-client.ts";
import {ccc} from "@ckb-ccc/core";
import {toDecimal, udtEq} from "../../utils.ts";

export function formatNodeInfo(nodeInfo: GetNodeInfoResponse): string {
    nodeInfo = convert(nodeInfo, GetNodeInfoResponseNumberKeys);
    nodeInfo.udt_cfg_infos = nodeInfo.udt_cfg_infos.map(udt => convert(udt, UdtArgInfoNumberKeys));

    const {
        version,
        commit_hash,
        node_name,
        node_id,
        addresses,
        open_channel_auto_accept_min_ckb_funding_amount,
        auto_accept_channel_ckb_funding_amount,
        tlc_expiry_delta,
        default_funding_lock_script,
        tlc_min_value,
        tlc_max_value,
        tlc_fee_proportional_millionths,
        channel_count,
        pending_channel_count,
        peers_count,
        udt_cfg_infos,
    } = nodeInfo;

    // Format UDT information
    const supportedUdtKeys = Object.keys(SupportedUDTs)

    const udtInfos = supportedUdtKeys
        .map(udtType => ({
            name: udtType, ...SupportedUDTs[udtType],
            config: udt_cfg_infos.find(udt => udtEq(SupportedUDTs[udtType].script, udt.script))
        }))
        .filter(udt => !!udt.config)
        .map(udt => `- ${udt.name}: ${udt.description}
        Decimal: ${udt.decimal}
        Auto Accept Amount: ${toDecimal(udt.config.auto_accept_amount, udt.name)} ${udt.name}`)
        .join('\n');

    const lockScript = {
        codeHash: default_funding_lock_script.code_hash,
        hashType: default_funding_lock_script.hash_type,
        args: default_funding_lock_script.args
    }
    const script = ccc.Script.from(lockScript)
    const address = ccc.Address.fromScript(script, cccClient)

    // Format node status
    return `Node Status:
- Version: ${version}
- Name: ${node_name || 'Unnamed Node'}
- Node ID: ${node_id}
- Wallet: ${address.toString()}
- Channels: ${channel_count} (${pending_channel_count} pending)
- Connected Peers: ${peers_count}

Channel Configuration:
- TLC Min Value: ${toDecimal(tlc_min_value)} CKB
- TLC Max Value: ${toDecimal(tlc_max_value)} CKB
- TLC Fee Rate: ${tlc_fee_proportional_millionths} millionths
- Auto Accept Funding: ${toDecimal(open_channel_auto_accept_min_ckb_funding_amount)} CKB

Supported UDT Tokens:
${udtInfos}`;
}

export function formatChannelList(channelList: ChannelListResponse): string {
    if (!channelList.channels || channelList.channels.length === 0) {
        return 'No channels found.';
    }

    const channels = channelList.channels.map(channel => {
        const {
            channel_id,
            peer_id,
            state,
            local_balance,
            remote_balance,
            offered_tlc_balance,
            received_tlc_balance,
            funding_udt_type_script,
            is_public
        } = channel;

        // Try to find matching UDT type
        let balanceFormat = '';

        if (funding_udt_type_script) {
            const udtType = Object.entries(SupportedUDTs).find(([_, udt]) =>
                udtEq(udt.script, funding_udt_type_script)
            );
            if (udtType) {
                const [name] = udtType;
                balanceFormat = `
    Local: ${toDecimal(local_balance, name)} ${name} (${toDecimal(offered_tlc_balance, name)} ${name} TLC offered)
    Remote: ${toDecimal(remote_balance, name)} ${name} (${toDecimal(received_tlc_balance, name)} ${name} TLC received)`;
            }
        } else {
            // Default to CKB
            balanceFormat = `
    Local: ${toDecimal(local_balance)} CKB (${toDecimal(offered_tlc_balance)} CKB TLC offered)
    Remote: ${toDecimal(remote_balance)} CKB (${toDecimal(received_tlc_balance)} CKB TLC received)`;
        }

        return `- Channel ${channel_id}:
    To Peer: ${peer_id}
    State: ${state.state_name} [${state?.state_flags?.join?.(', ') || 'null'}]
    Public: ${is_public}${balanceFormat}`;
    });

    return `Channels:\n${channels.join('\n\n')}`;
}

export function formatPayment(payment: PaymentResponse): string {

}
