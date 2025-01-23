# Description

Implementation of a EmailClient for Eliza.

# Settings

The following settings will be declared on your environment variable or inside your agent' settings:

## SMTP Section

- `EMAIL_OUTGOING_SERVICE`: "smtp" | "gmail"
- `EMAIL_OUTGOING_HOST`: SMTP Hostname or IP to connect to. Required only when "smtp" service is configured.
- `EMAIL_OUTGOING_PORT`: the port to connect to (defaults to 465 for secure connections, otherwise 587). Required only if "smtp" is configured.
- `EMAIL_SECURE`: if true the connection will use TLS, otherwise TLS will be used if server supports STARTLS extension. Set to true if port 465 is selected.
- `EMAIL_OUTGOING_USER`: Username
- `EMAIL_OUTGOING_PASS`: Password. If "gmail" selected you will need to provision a dedicated password for the agent [1]

## IMAP Section

- `EMAIL_INCOMING_SERVICE`: "imap"
- `EMAIL_INCOMING_HOST`: IMAP Hostname or IP to conenct to
- `EMAIL_INCOMING_PORT`: the port to connect to (defaults to 993)
- `EMAIL_INCOMING_USER`: Username
- `EMAIL_INCOMING_PASS`: Password

[1] https://support.google.com/mail/answer/185833?hl=en

## Usage

1. Install the Plugin: First, import the plugin into your agent by running the following command:

```
pnpm add @elizaos/plugin-email
```

2. Send Emails: You can send emails using the following method:

```
this.runtime.clients.email.send({
    to: "recipient@example.com",
    subject: "Your Subject Here",
    text: "Your email body here."
});
```

3. Receive Emails: To receive emails, register a callback function that will be invoked when an email is received:

```
this.runtime.clients.email.receive((email) => {
    console.log("Email Received:", email);
});
```
