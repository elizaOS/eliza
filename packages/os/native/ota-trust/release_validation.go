package otatrust

import "errors"

// ValidateReleaseDescriptor checks the release contract against the compiled
// product identity and independently supplied repository and artifact hosts.
// It does not authenticate metadata, inspect APK bytes, assess a device, or
// authorize publication. Release tools must perform those checks separately.
func ValidateReleaseDescriptor(descriptor []byte, repository string, artifactHosts []string) error {
	if !matches(repository, repositoryPattern) {
		return errors.New("invalid release repository policy")
	}
	var release releaseDescriptor
	if err := decodeAdmission(descriptor, &release); err != nil {
		return err
	}
	if err := validateNativeRelease(release, artifactHosts); err != nil {
		return err
	}
	if release.Source.Repository != repository {
		return errors.New("release repository mismatch")
	}
	return nil
}
