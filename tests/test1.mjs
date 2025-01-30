import assert from "node:assert";
import { send, log, logError, runIntegrationTest } from "./testLibrary.mjs";

async function helloTrump() {
    const reply = await send("Hi");
    assert(reply.length > 0, "Response should not be empty");
    const response = reply[0];
    assert(response.text, "Response should have text property");
    assert(
        response.text.length > 10,
        `Response should be longer than 10 characters, is ${reply.length}`
    );
}
helloTrump.description = "Hello Trump";
helloTrump.skipIf = !process.env.OPENAI_API_KEY;

async function coinbaseCommerceChargeTest() {
    const chargeDescription = "Exclusive digital artwork collection";
    const chargeRequest = `Create a charge for $100 USD for Digital Art NFT with description '${chargeDescription}'`;
    const response = await send(chargeRequest);

    // Verify response structure
    assert(Array.isArray(response), "Response should be an array");
    assert(response.length === 2, "Response should contain two messages");

    // Verify initial response
    const initialResponse = response[0];
    assert.strictEqual(initialResponse.action, "CREATE_CHARGE");

    // Verify charge creation response
    const chargeResponse = response[1];
    assert(
        chargeResponse.text.startsWith("Charge created successfully:"),
        "Should indicate successful charge creation"
    );
    assert(
        chargeResponse.text.includes("https://commerce.coinbase.com/pay/"),
        "Should contain valid Coinbase Commerce URL"
    );

    // Verify attachment structure
    assert(
        Array.isArray(chargeResponse.attachments),
        "Should have attachments array"
    );
    assert(
        chargeResponse.attachments.length === 1,
        "Should have one attachment"
    );

    const attachment = chargeResponse.attachments[0];
    assert.strictEqual(attachment.source, "coinbase");
    assert.strictEqual(attachment.title, "Coinbase Commerce Charge");
    assert(attachment.id, "Should have an ID");
    assert(attachment.url, "Should have a charge ID URL");
    assert(
        attachment.description.startsWith("Charge ID:"),
        "Should have charge ID description"
    );
    assert(attachment.text.startsWith("Pay here:"), "Should have payment URL");
    assert(
        attachment.text.includes("https://commerce.coinbase.com/pay/"),
        "Should have valid Coinbase Commerce URL"
    );

    // Store the created charge ID for later comparison
    const createdChargeId = attachment.id;
    const createdChargeUrl = attachment.url;

    // Fetch and verify all charges
    const chargesResponse = await send("Fetch all charges");

    // Verify response structure
    assert(
        Array.isArray(chargesResponse),
        "Charges response should be an array"
    );
    assert(
        chargesResponse.length === 2,
        "Should have two messages (prompt and response)"
    );

    // Verify charges data
    const charges = chargesResponse[1].attachments;
    assert(Array.isArray(charges), "Charges should be an array");
    assert(charges.length > 0, "Should have at least one charge");

    // Verify each charge has required properties
    for (const charge of charges) {
        assert(charge.id, "Each charge should have an id");
        assert(charge.hosted_url, "Each charge should have a hosted_url");
        assert(
            charge.hosted_url.includes("commerce.coinbase.com/pay/"),
            "hosted_url should be a valid Coinbase URL"
        );
        assert(charge.web3_data, "Each charge should have web3_data object");
    }

    // Verify the previously created charge exists in the list
    const foundCharge = charges.find((charge) => charge.id === createdChargeId);
    assert(foundCharge, "Previously created charge should exist in the list");
    assert.strictEqual(
        foundCharge.hosted_url,
        createdChargeUrl,
        "Hosted URL should match"
    );
    assert.strictEqual(
        foundCharge.description,
        chargeDescription,
        "Description should match"
    );

    // Test GetChargeDetails action
    const getDetailsResponse = await send(
        `Get details for charge ID: ${createdChargeId}`
    );

    // Verify response structure for charge details
    assert(
        Array.isArray(getDetailsResponse),
        "GetChargeDetails response should be an array"
    );
    assert(
        getDetailsResponse.length === 2,
        "Should have two messages (prompt and response)"
    );

    // Verify charge details response
    const detailsResponse = getDetailsResponse[1];
    assert(
        Array.isArray(detailsResponse.attachments),
        "Should have attachments array"
    );

    const detailsAttachment = detailsResponse.attachments[0];

    const chargeData = JSON.parse(detailsAttachment.description);

    assert.equal(
        chargeData.data.hosted_url,
        createdChargeUrl,
        "Hosted URLs should match"
    );
    assert.equal(
        chargeData.data.description,
        chargeDescription,
        "Charge description should match"
    );
}
coinbaseCommerceChargeTest.description = "Coinbase Commerce Charge";
coinbaseCommerceChargeTest.skipIf =
    !process.env.OPENAI_API_KEY || !process.env.COINBASE_COMMERCE_KEY;

const testSuite = [helloTrump, coinbaseCommerceChargeTest];
try {
    for (const test of testSuite) await runIntegrationTest(test);
} catch (error) {
    logError(error);
    process.exit(1);
}
