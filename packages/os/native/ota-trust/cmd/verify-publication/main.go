// Offline signed TUF publication-closure verification; no network or signing.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	trust "github.com/elizaOS/eliza/packages/os/native/ota-trust"
)

func read(name string, limit int64) ([]byte, error) {
	s, e := os.Lstat(name)
	if e != nil {
		return nil, e
	}
	if !s.Mode().IsRegular() || s.Size() < 1 || s.Size() > limit {
		return nil, fmt.Errorf("bounded regular file required")
	}
	f, e := os.Open(name)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("file grew beyond limit")
	}
	return b, e
}
func run() error {
	root := flag.String("root", "", "provisioned root JSON")
	bundle := flag.String("bundle", "", "publication files JSON (base64 values)")
	policy := flag.String("policy", "", "qualified time and durable role floors JSON")
	flag.Parse()
	if *root == "" || *bundle == "" || *policy == "" || flag.NArg() != 0 {
		return fmt.Errorf("root, bundle and policy required")
	}
	r, e := read(*root, 1024*1024)
	if e != nil {
		return e
	}
	b, e := read(*bundle, 96*1024*1024)
	if e != nil {
		return e
	}
	p, e := read(*policy, 1024*1024)
	if e != nil {
		return e
	}
	result, e := trust.VerifyPublicationGraph(r, b, p)
	if e != nil {
		return e
	}
	fmt.Println(string(result))
	return nil
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
