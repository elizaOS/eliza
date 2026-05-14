package Test::WebServer::RedirectToHTTPS;

use strictures 2;
use Carp::Assert;

use parent qw{Test::WebServer};

sub handle_request {
    my ($self, $cgi) = @_;

    assert(exists  $self->{target});
    assert(defined $self->{target});

    print "HTTP/1.0 301 Moved Permanently\r\n";
    print "Location: https://".$self->{target}.$cgi->path_info()."\r\n";
}

1;
