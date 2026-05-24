=head1 NAME

Tails::Download::HTTPS - download content over HTTPS

=cut

package Tails::Download::HTTPS;

no Moo::sification;
use Moo;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Function::Parameters;
use Types::Standard qw{HashRef Int Str};
use WWW::Curl::Easy;

use namespace::clean;

=head1 ATTRIBUTES

=cut

has 'max_download_size' => (
    is   => 'lazy',
    isa  => Int,
);
has 'curl_opts' => (
    is  => 'lazy',
    isa => HashRef
);


=head1 CONSTRUCTORS AND BUILDERS

=cut

method _build_max_download_size () { 8 * 2**10 }

method _build_curl_opts () {
    my @opts = (
        CURLOPT_NOPROGRESS,      1,
        # This does *not* prevent curl from downloading more data this in the end.
        CURLOPT_MAXFILESIZE,     $self->max_download_size,
        CURLOPT_SSLVERSION,      CURL_SSLVERSION_TLSv1_3,
    );
    if ($ENV{HARNESS_ACTIVE} or $ENV{DISABLE_PROXY}) {
        push @opts, CURLOPT_PROXY,     '';
    }
    else {
        push @opts, CURLOPT_PROXYTYPE, CURLPROXY_SOCKS5_HOSTNAME;
        push @opts, CURLOPT_PROXY,     '127.0.0.1:9062';
    }
    if ($ENV{HARNESS_ACTIVE}) {
        # Trust the additional Certificate Authority requested by the test suite
        push @opts, CURLOPT_CAINFO, $ENV{HTTPS_CA_FILE};
    }
    push @opts, CURLOPT_SSL_VERIFYHOST,  2;
    push @opts, CURLOPT_SSL_VERIFYPEER,  1;
    push @opts, CURLOPT_PROTOCOLS,       CURLPROTO_HTTPS;
    push @opts, CURLOPT_REDIR_PROTOCOLS, CURLPROTO_HTTPS;
    my %opts = @opts;
    return \%opts;
}


=head2 get_url

Returns decoded content found at URL.
Throws an exception on detected failure.

=cut

method get_url (Str $url) {
    say STDERR "Downloading $url";
    my $curl  = WWW::Curl::Easy->new;
    $curl->setopt(CURLOPT_URL, $url);
    while (my ($k, $v) = each(%{$self->curl_opts})) {
        $curl->setopt($k, $v);
    }

    my $response_body;
    $curl->setopt(CURLOPT_WRITEDATA, \$response_body);
    my $retcode = $curl->perform;

    my $response_code;
    if ($retcode == 0) {
        $response_code = $curl->getinfo(CURLINFO_HTTP_CODE);
    } else {
        croak(sprintf(
            "Could not download '%s', request failed (%s): %s\n",
            $url, $curl->strerror($retcode), $curl->errbuf));
    }

    $response_code == 200 or croak(sprintf(
        "Could not download '%s', request failed (%s): %s\n",
        $url, $curl->strerror($retcode), $curl->errbuf,
    ));

    assert(defined $response_body);
    length $response_body or croak(sprintf(
        "Downloaded empty file at '%s'\n", $url
    ));

    length $response_body <= $self->max_download_size or croak(sprintf(
        "Downloaded from '%s' but the downloaded content (%d) should be smaller than %d",
        $url, length($response_body), $self->max_download_size,
    ));

    return $response_body;
}

no Moo;
1;
