/** Adds real upstream Robolectric routing tests to the reviewed Android overlay. */
const prefix =
  "components/webauthn/android/junit/src/org/chromium/components/webauthn/";
export function applyStandaloneCredManTests(edit, replaceOnce) {
  edit(`${prefix}AuthenticatorImplTest.java`, (source) => {
    source = replaceOnce(
      source,
      "import androidx.test.core.app.ApplicationProvider;",
      `import android.content.Context;
import android.content.ContextWrapper;
import android.credentials.CredentialManager;
import androidx.test.core.app.ApplicationProvider;
import org.robolectric.annotation.Config;
import org.chromium.base.ContextUtils;
import org.chromium.base.TriState;
import org.chromium.blink.mojom.PublicKeyCredentialReportOptions;
import org.chromium.components.webauthn.cred_man.CredManSupportProvider;`,
      "standalone authenticator test imports",
    );
    return replaceOnce(
      source,
      "    private void invokeIsUvpaaCallback(boolean isUvpaaAvailable) {",
      `    private void configureStandalone(boolean serviceAvailable) {
        CredentialManager manager = serviceAvailable ? org.robolectric.shadow.api.Shadow.newInstanceOf(CredentialManager.class) : null;
        ContextUtils.initApplicationContextForTests(new ContextWrapper(ApplicationProvider.getApplicationContext()) {
            @Override public Object getSystemService(String name) {
                return Context.CREDENTIAL_SERVICE.equals(name) ? manager : super.getSystemService(name);
            }
        });
        GmsCoreUtils.setGmsCoreVersionForTesting(-1);
        CredManSupportProvider.setupForTesting(null, TriState.NOT_SET);
    }

    @Test @Config(sdk = 34)
    public void testStandaloneCreateRoutesWithoutGms() {
        configureStandalone(true);
        PublicKeyCredentialCreationOptions options = new PublicKeyCredentialCreationOptions();
        Authenticator.MakeCredential_Response callback = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(options, callback);
        verify(mFido2CredentialRequestMock).handleMakeCredentialRequest(eq(options), any(), any(), any(), any());
        verify(callback, never()).call(anyInt(), any(), any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneGetRoutesWithoutGms() {
        configureStandalone(true);
        GetCredentialOptions options = new GetCredentialOptions();
        options.publicKey = new PublicKeyCredentialRequestOptions();
        Authenticator.GetCredential_Response callback = mock(Authenticator.GetCredential_Response.class);
        mAuthenticator.getCredential(options, callback);
        verify(mFido2CredentialRequestMock).handleGetCredentialRequest(eq(options), any(), any(), any());
        verify(callback, never()).call(any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneNoServiceIsUnavailable() {
        configureStandalone(false);
        Authenticator.MakeCredential_Response callback = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(new PublicKeyCredentialCreationOptions(), callback);
        verify(callback).call(eq(AuthenticatorStatus.NOT_IMPLEMENTED), any(), any());
        verify(mFido2CredentialRequestMock, never()).handleMakeCredentialRequest(any(), any(), any(), any(), any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneBackgroundCreateIsDenied() {
        configureStandalone(true);
        when(mWebContents.getVisibility()).thenReturn(Visibility.HIDDEN);
        Authenticator.MakeCredential_Response callback = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(new PublicKeyCredentialCreationOptions(), callback);
        verify(callback).call(eq(AuthenticatorStatus.NOT_FOCUSED), any(), any());
        verify(mFido2CredentialRequestMock, never()).handleMakeCredentialRequest(any(), any(), any(), any(), any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneConditionalCreateIsNotAdvertisedOrDispatched() {
        configureStandalone(true);
        PublicKeyCredentialCreationOptions options = new PublicKeyCredentialCreationOptions();
        options.isConditional = true;
        Authenticator.MakeCredential_Response callback = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(options, callback);
        verify(callback).call(eq(AuthenticatorStatus.NOT_IMPLEMENTED), any(), any());
        verify(mFido2CredentialRequestMock, never()).handleMakeCredentialRequest(any(), any(), any(), any(), any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneReportDenialResetsPendingRequest() {
        configureStandalone(true);
        Authenticator.Report_Response report = mock(Authenticator.Report_Response.class);
        mAuthenticator.report(new PublicKeyCredentialReportOptions(), report);
        verify(report).call(eq(AuthenticatorStatus.NOT_IMPLEMENTED), org.mockito.ArgumentMatchers.isNull());
        verify(mFido2CredentialRequestMock, never()).handleReportRequest(any(), any());
        Authenticator.MakeCredential_Response create = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(new PublicKeyCredentialCreationOptions(), create);
        verify(mFido2CredentialRequestMock).handleMakeCredentialRequest(any(), any(), any(), any(), any());
        verify(create, never()).call(anyInt(), any(), any());
    }

    @Test @Config(sdk = 34)
    public void testStandaloneDoesNotEnableAppMode() {
        configureStandalone(true);
        when(mModeProviderMock.getWebauthnMode(any())).thenReturn(WebauthnMode.APP);
        when(mModeProviderMock.getGlobalWebauthnMode()).thenReturn(WebauthnMode.APP);
        Authenticator.MakeCredential_Response callback = mock(Authenticator.MakeCredential_Response.class);
        mAuthenticator.makeCredential(new PublicKeyCredentialCreationOptions(), callback);
        verify(callback).call(eq(AuthenticatorStatus.NOT_IMPLEMENTED), any(), any());
        verify(mFido2CredentialRequestMock, never()).handleMakeCredentialRequest(any(), any(), any(), any(), any());
    }

    private void invokeIsUvpaaCallback(boolean isUvpaaAvailable) {`,
      "standalone authenticator actual routing cases",
    );
  });
  edit(`${prefix}Fido2CredentialRequestRobolectricTest.java`, (source) => {
    source = replaceOnce(
      source,
      "import android.content.Context;",
      "import android.content.Context;\nimport android.content.ContextWrapper;\nimport org.chromium.base.ContextUtils;",
      "standalone request test imports",
    );
    return replaceOnce(
      source,
      "    private void handleMakeCredentialRequest(Bundle browserOptions) {",
      `    private void configureStandaloneRequest() {
        CredentialManager manager = org.robolectric.shadow.api.Shadow.newInstanceOf(CredentialManager.class);
        ContextUtils.initApplicationContextForTests(new ContextWrapper(ApplicationProvider.getApplicationContext()) {
            @Override public Object getSystemService(String name) {
                return Context.CREDENTIAL_SERVICE.equals(name) ? manager : super.getSystemService(name);
            }
        });
        GmsCoreUtils.setGmsCoreVersionForTesting(-1);
        CredManSupportProvider.setupForTesting(null, TriState.NOT_SET);
        mFido2ApiCallHelper.setArePlayServicesAvailable(false);
        mRequest = new Fido2CredentialRequest(mAuthenticationContextProviderMock);
        mRequest.overrideBrowserBridgeForTesting(mBrowserBridgeMock);
        mRequest.setCredManHelperForTesting(mCredManHelperMock);
        mRequest.setBarrierForTesting(mBarrierMock);
    }

    @Test @Config(sdk = 34)
    public void testStandaloneRkDiscouragedPreservesOptionsAndUsesCredMan() {
        configureStandaloneRequest();
        mCreationOptions.authenticatorSelection.residentKey = ResidentKeyRequirement.DISCOURAGED;
        handleMakeCredentialRequest(null);
        verify(mCredManHelperMock).startMakeRequest(eq(mCreationOptions), any(), any(), any());
        assertThat(mCreationOptions.authenticatorSelection.residentKey).isEqualTo(ResidentKeyRequirement.DISCOURAGED);
        assertThat(mFido2ApiCallHelper.mMakeCredentialCalled).isFalse();
    }

    @Test @Config(sdk = 34)
    public void testStandaloneAllowCredentialsDoesNotEnumerateOrFallbackToGms() {
        configureStandaloneRequest();
        mRequestOptions.publicKey = Fido2ApiTestHelper.createDefaultGetAssertionOptions();
        handleGetCredentialRequest();
        verify(mCredManHelperMock).startGetRequest(eq(mRequestOptions), any(), any(), any(), eq(false));
        verify(mCredManHelperMock).setNoCredentialsFallback(Mockito.isNull());
        verifyNoInteractions(mGmsCoreGetCredentialsHelperMock);
        assertThat(mFido2ApiCallHelper.mGetAssertionCalled).isFalse();
        mRequest.cancelGetAssertion();
        verify(mCredManHelperMock).cancelGetAssertion(AuthenticatorStatus.ABORT_ERROR);
    }

    @Test @Config(sdk = 34)
    public void testStandaloneRpFailureNeverReachesCredentialManager() {
        configureStandaloneRequest();
        doAnswer(invocation -> {
            Callback<WebAuthSecurityChecksResults> callback = invocation.getArgument(5);
            callback.onResult(new WebAuthSecurityChecksResults(AuthenticatorStatus.NOT_ALLOWED_ERROR, false));
            return null;
        }).when(mFrameHost).performMakeCredentialWebAuthSecurityChecks(any(), any(), anyBoolean(), any(), any(), any());
        handleMakeCredentialRequest(null);
        verify(mCredManHelperMock, never()).startMakeRequest(any(), any(), any(), any());
        assertThat(mFido2ApiCallHelper.mMakeCredentialCalled).isFalse();
        assertThat(mCallback.getStatus()).isEqualTo(Integer.valueOf(AuthenticatorStatus.NOT_ALLOWED_ERROR));
    }

    private void handleMakeCredentialRequest(Bundle browserOptions) {`,
      "standalone actual credential request cases",
    );
  });
}
