// verify-release validates a descriptor supplied on stdin. The invoking release
// host owns process cancellation; this command supplies no signing authority.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	trust "github.com/elizaOS/eliza/packages/os/native/ota-trust"
)

func run() error {
	repository := flag.String("repository", "", "independently approved repository")
	hosts := flag.String("hosts", "", "comma-separated approved artifact hosts")
	flag.Parse()
	if *repository == "" || *hosts == "" || flag.NArg() != 0 {
		return fmt.Errorf("repository and hosts are required")
	}
	const limit = 1024 * 1024
	descriptor, err := io.ReadAll(io.LimitReader(os.Stdin, limit+1))
	if err != nil {
		return err
	}
	if len(descriptor) == 0 || len(descriptor) > limit {
		return fmt.Errorf("bounded release descriptor required")
	}
	if err = trust.ValidateReleaseDescriptor(descriptor, *repository, strings.Split(*hosts, ",")); err != nil {
		return err
	}
	digest := sha256.Sum256(descriptor)
	return json.NewEncoder(os.Stdout).Encode(struct {
		ReleaseContractVerified bool   `json:"releaseContractVerified"`
		DescriptorSHA256        string `json:"descriptorSha256"`
		Authenticated           bool   `json:"authenticated"`
	}{true, hex.EncodeToString(digest[:]), false})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
