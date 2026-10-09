package otatrust

import (
	"encoding/json"
	"errors"
	"strings"
)

// EnrolledDiscovery binds one native discovery attempt to durable enrollment.
// Callers supply live device observations, qualified time, the installed/global
// security floor and journal generation. They cannot select trust roots, hosts,
// repository, metadata base, or a different installed signer/cohort identity.
// This API does not establish those live observations or authorize installation.
type EnrolledDiscovery struct {
	session    *discoverySession
	directory  string
	identity   string
	enrollment *Enrollment
	config     enrollmentConfig
}

// NewEnrolledDiscoveryWithTimeSource binds TLS, TUF, scheduling and admission to
// one native source. Time is refreshed during each discovery stage.
func NewEnrolledDiscoveryWithTimeSource(directory string, source TrustedTimeSource) (*EnrolledDiscovery, error) {
	if _, err := readTimeBounds(source); err != nil {
		return nil, err
	}
	d, err := newEnrolledDiscovery(directory, func(hosts string) (discoveryTransport, error) { return NewHTTPTransportWithTimeSource(hosts, source) })
	if err != nil {
		return nil, err
	}
	d.session.source = source
	return d, nil
}

func newEnrolledDiscovery(directory string, transport func(string) (discoveryTransport, error)) (*EnrolledDiscovery, error) {
	enrollment, err := ReadEnrollment(directory)
	if err != nil {
		return nil, err
	}
	var config enrollmentConfig
	if err = decodeAdmission(enrollment.Config, &config); err != nil {
		return nil, err
	}
	identity, err := admissionHash(enrollment)
	if err != nil {
		return nil, err
	}
	network, err := transport(strings.Join(config.Hosts, ","))
	if err != nil {
		return nil, err
	}
	return &EnrolledDiscovery{session: &discoverySession{transport: network}, directory: directory, identity: identity, enrollment: enrollment, config: config}, nil
}
func (d *EnrolledDiscovery) Close() { d.session.Close() }
func (d *EnrolledDiscovery) unchanged() error {
	current, err := ReadEnrollment(d.directory)
	if err != nil {
		return err
	}
	identity, err := admissionHash(current)
	if err != nil {
		return err
	}
	if identity != d.identity {
		return errors.New("enrollment changed during discovery")
	}
	return nil
}

// RunWithTimeSource accepts no wall-clock/point-time override. Source failure
// returns no descriptor and leaves any acquired schedule claim for recovery.
func (d *EnrolledDiscovery) RunWithTimeSource(scheduleDirectory, trustDirectory, admissionDirectory, authorizationDirectory string, deviceJSON []byte, securityFloor, generation int64) (*DiscoveryResult, error) {
	bounds, err := readTimeBounds(d.session.source)
	if err != nil {
		d.Close()
		return nil, err
	}
	defer d.Close()
	if !bounded(securityFloor, 1, safeInteger) || generation < 0 {
		return nil, errors.New("invalid qualified discovery observations")
	}
	if err := d.unchanged(); err != nil {
		return nil, err
	}
	var device admissionDevice
	if err := decodeAdmission(deviceJSON, &device); err != nil {
		return nil, err
	}
	if err := validateAdmissionDevice(device); err != nil {
		return nil, err
	}
	if device.Distribution != d.config.Distribution || device.Signer != d.config.Signer || device.CohortID != d.enrollment.CohortID {
		return nil, errors.New("device does not match enrollment")
	}
	policy, err := json.Marshal(admissionPolicy{Repository: d.config.Repository, Hosts: d.config.Hosts, Lower: bounds.LowerMillis, Upper: bounds.UpperMillis, Sequence: 1, Revision: 1, SecurityFloor: securityFloor})
	if err != nil {
		return nil, err
	}
	result, err := d.session.RunPrepared(scheduleDirectory, trustDirectory, admissionDirectory, authorizationDirectory, d.enrollment.Root, d.config.MetadataBase, deviceJSON, policy, generation)
	if err != nil {
		return nil, err
	}
	if err = d.unchanged(); err != nil {
		return nil, err
	}
	return result, nil
}
