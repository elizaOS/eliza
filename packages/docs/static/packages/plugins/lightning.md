# @elizaos/plugin-lightning

## Purpose

This plugin enables creating lightning invoices or paying invoices.

## Key Features

- 💱 Make a new off-chain invoice.
- 📊 Make an off-chain payment.

## Installation

Add the plugin to your Eliza configuration:

```json
{
  "plugins": ["@elizaos/plugin-lightning"]
}
```

## Configuration

Set the following environment variables:

```env
LND_TLS_CERT=your_lnnode_tls_cert   #Base64 of LND certificate
LND_MACAROON=020.....        #Base64 encoded admin.macaroon file
LND_SOCKET='x.x.x.x:10009'
```

## Example Usage

### CREATE_INVOICE

```text
"Help me create an invoice for 1000sats"
"Create an invoice for 1000sats"
```

Returns: lnbcrt....

### PAY_INVOICE

```text
"Pay invoice lnbcrt10u1pncndjvpp58y77adkngcz3ypx6t39j245ydvk2vu67c8ugvegee3gt5wgs7yjqdxvdec82c33wdmnq73s0qcxwurrxp4nquncxe4h56m9xu6xwetyd3mrq6ehdguxkd35wuurgarex4u8gefkdsekgdtnddehxurrxecxvhmwwp6kyvfexekhxwtv8paryvnpwsuhxdryvachwangw3kn2atddq6kzvrvwfcxzanewce8ja34d43k56rkweu8jdtcwv68zmrsvdescqzzsxqrrsssp5q3hv38wfprvaazzwf8c4t33tzjcac5xz94sk8muehmn5szqaw6ks9qxpqysgqt5pjhna4922s8ayzgu5rh8clx7psp2culdr5r6cxxxqzs3e5ep345p45vggg0qegt6fu3prdrqgpd8v70l9wdhekt8gex5e8pqvxg2sp97fkmd"
```
