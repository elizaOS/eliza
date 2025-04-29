# Email Plugin

## Purpose

Implementation of an EmailClient for Eliza.

## Configuration

### SMTP Section

- `EMAIL_OUTGOING_SERVICE`: "smtp" | "gmail"
- `EMAIL_OUTGOING_HOST`: SMTP Hostname or IP (required for "smtp" service)
- `EMAIL_OUTGOING_PORT`: Port to connect to (defaults: 465 for secure, 587 otherwise)
- `EMAIL_SECURE`: If true uses TLS, otherwise uses TLS if server supports STARTTLS
- `EMAIL_OUTGOING_USER`: Username
- `EMAIL_OUTGOING_PASS`: Password

### IMAP Section

- `EMAIL_INCOMING_SERVICE`: "imap"
- `EMAIL_INCOMING_HOST`: IMAP Hostname or IP
- `EMAIL_INCOMING_PORT`: Port to connect to (defaults: 993)
- `EMAIL_INCOMING_USER`: Username
- `EMAIL_INCOMING_PASS`: Password

## Installation

```
bun add @elizaos/plugin-email
```

## Integration

Connects with ElizaOS through the runtime.clients.email interface.

## Example Usage

```
this.runtime.clients.email.send({
    to: "recipient@example.com",
    subject: "Your Subject Here",
    text: "Your email body here."
});

this.runtime.clients.email.receive((email) => {
    console.log("Email Received:", email);
});
```

## Links

https://support.google.com/mail/answer/185833?hl=en
