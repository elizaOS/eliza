package otatrust

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// Reject duplicate keys before a downstream decoder can silently choose one.
// Signature canonicalization remains entirely the reference library's job.
func checkJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var read func(int) error
	read = func(depth int) error {
		if depth > 64 {
			return errors.New("metadata JSON nesting limit")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate metadata JSON key")
				}
				seen[name] = true
				if err = read(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return errors.New("unclosed JSON object")
			}
		case '[':
			for decoder.More() {
				if err = read(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return errors.New("unclosed JSON array")
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		return nil
	}
	if err := read(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
