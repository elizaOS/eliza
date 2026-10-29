package ai.eliza.auth.cloud;

/** A synthetic registered app on Eliza Cloud's production and staging deployments. */
final class TestRegistration {
 private TestRegistration() {}
 static final CloudSignInEnvironment PRODUCTION = new CloudSignInEnvironment("production", "api.eliza.app", "eliza.app", "elizacloud", "Eliza Cloud", "/example/auth/callback");
 static final CloudSignInEnvironment STAGING = new CloudSignInEnvironment("staging", "api-staging.eliza.app", "staging.eliza.app", "elizacloud-staging", "Eliza Cloud", "/example/auth/callback");
 static CloudSignInConfig.Builder base() {
  return CloudSignInConfig.builder().clientId("ai.example.signin").deviceName("Example Phone").productName("Example Phone").googleClientId("example-app");
 }
 /** A product build: production only. */
 static final CloudSignInConfig PRODUCT = base().environment(PRODUCTION).build();
 /** A development build that also admits staging. */
 static final CloudSignInConfig DEVELOPMENT = base().environment(PRODUCTION).environment(STAGING).build();
}
