// spec/os/build/runtimePayload.md, "The APK carries exactly one Node runtime for each targeted ABI and none for another"; spec/os/build/runtimePayload.md, "The inventory lists every staged payload file once, by digest and size, and nothing else"
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	trust "github.com/elizaOS/eliza/packages/os/native/ota-trust"
	"strings"
)

func run(args []string) error {
	flags := flag.NewFlagSet("verify-runtime", flag.ContinueOnError)
	apk := flags.String("apk", "", "private APK snapshot")
	artifact := flags.String("artifact", "", "artifact descriptor JSON")
	hosts := flags.String("hosts", "", "comma-separated approved hosts")
	abis := flags.String("abis", "", "comma-separated qualified ABIs")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *apk == "" || *artifact == "" || *hosts == "" || *abis == "" {
		return fmt.Errorf("apk, artifact, hosts and abis are required")
	}
	stat, err := os.Lstat(*artifact)
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 1024*1024 {
		return fmt.Errorf("artifact descriptor must be a bounded regular file")
	}
	file, err := os.Open(*artifact)
	if err != nil {
		return err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil {
		return err
	}
	if len(bytes) > 1024*1024 {
		return fmt.Errorf("artifact descriptor too large")
	}
	for _, abi := range strings.Split(*abis, ",") {
		if err = trust.VerifyRuntimeArtifact(*apk, bytes, *hosts, abi); err != nil {
			return err
		}
	}
	return nil
}
func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(`{"runtimeBytesVerified":true,"authenticated":false}`)
}
