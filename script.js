document.getElementById("year").textContent = new Date().getFullYear();

const sections = document.querySelectorAll(".section, .contact");
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.animate(
        [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" }
      );
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.08 });

sections.forEach((section) => observer.observe(section));
