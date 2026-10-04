package otatrust

// Interval scheduling compares due times with the earliest possible current
// time, and starts future delays from the latest possible current time. The
// durable rollback floor remains a lower bound. This conservatively waits rather
// than waking early when uncertainty grows; it does not establish clock trust.
func BeginDiscoveryInterval(directory string, lowerMillis, upperMillis, generation int64) (*CheckDecision, error) {
	return beginScheduledWork(directory, lowerMillis, upperMillis, generation, leaseMillis)
}

func FinishDiscoveryInterval(directory, token string, lowerMillis, upperMillis int64, success bool, retryAfterMillis int64) (*CheckDecision, error) {
	return finishScheduledWork(directory, token, lowerMillis, upperMillis, success, retryAfterMillis, false)
}

func BeginStagingInterval(directory string, lowerMillis, upperMillis, generation int64) (*CheckDecision, error) {
	return beginScheduledWork(directory, lowerMillis, upperMillis, generation, 35*60*1000)
}

func FinishStagingInterval(directory, token string, lowerMillis, upperMillis int64, success bool, retryAfterMillis int64) (*CheckDecision, error) {
	return finishScheduledWork(directory, token, lowerMillis, upperMillis, success, retryAfterMillis, true)
}
