
export type CreateInvoiceArgs = {
  /** CLTV Delta */
  cltv_delta?: number;
  /** Invoice Description */
  description?: string;
  /** Hashed Description of Payment Hex String */
  description_hash?: string;
  /** Expires At ISO 8601 Date */
  expires_at?: string;
  /** Use Blinded Paths For Inbound Routes */
  is_encrypting_routes?: boolean;
  /** Is Fallback Address Included */
  is_fallback_included?: boolean;
  /** Is Fallback Address Nested */
  is_fallback_nested?: boolean;
  /** Invoice Includes Private Channels */
  is_including_private_channels?: boolean;
  /** Payment Preimage Hex String */
  secret?: string;
  /** Millitokens */
  mtokens?: string;
  routes?: any;
  /** Tokens */
  tokens?: number;
  asset_id?: string;
  peer_pubkey?: string;
  tpr?: any;
};

export type PayArgs = {
    /** Pay Through Specific Final Hop Public Key Hex */
    incoming_peer?: string;
    /** Maximum Additional Fee Tokens To Pay */
    max_fee?: number;
    /** Maximum Fee Millitokens to Pay */
    max_fee_mtokens?: string;
    /** Maximum Millitokens For A Multi-Path Path */
    max_path_mtokens?: string;
    /** Maximum Simultaneous Paths */
    max_paths?: number;
    /** Max CLTV Timeout */
    max_timeout_height?: number;
    messages?: {
        /** Message Type number */
        type: string;
        /** Message Raw Value Hex Encoded */
        value: string;
    }[];
    /** Millitokens to Pay */
    mtokens?: string;
    /** Pay Through Outbound Standard Channel Id */
    outgoing_channel?: string;
    /** Pay Out of Outgoing Channel Ids */
    outgoing_channels?: string[];
    path?: {
        /** Payment Hash Hex */
        id: string;
        routes: {
            /** Total Fee Tokens To Pay */
            fee: number;
            /** Total Fee Millitokens To Pay */
            fee_mtokens: string;
            hops: {
                /** Standard Format Channel Id */
                channel: string;
                /** Channel Capacity Tokens */
                channel_capacity: number;
                /** Fee */
                fee: number;
                /** Fee Millitokens */
                fee_mtokens: string;
                /** Forward Tokens */
                forward: number;
                /** Forward Millitokens */
                forward_mtokens: string;
                /** Public Key Hex */
                public_key?: string;
                /** Timeout Block Height */
                timeout: number;
            }[];
            messages?: {
                /** Message Type number */
                type: string;
                /** Message Raw Value Hex Encoded */
                value: string;
            }[];
            /** Total Millitokens To Pay */
            mtokens: string;
            /** Payment Identifier Hex */
            payment?: string;
            /** Expiration Block Height */
            timeout: number;
            /** Total Tokens To Pay */
            tokens: number;
        }[];
    };
    /** Time to Spend Finding a Route Milliseconds */
    pathfinding_timeout?: number;
    /** BOLT 11 Payment Request */
    request?: string;
    /** Total Tokens To Pay to Payment Request */
    tokens?: number;
};
