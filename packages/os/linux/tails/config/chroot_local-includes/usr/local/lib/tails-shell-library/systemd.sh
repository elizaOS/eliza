#!/bin/sh

tor_has_bootstrapped() {
	/bin/systemctl --quiet is-active tails-tor-has-bootstrapped.target
}
