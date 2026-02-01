const blacklist = [
  "Zaawansowane aplikacje webowe",
  "Programowanie aplikacji desktopowych",
  "Programowanie aplikacji mobilnych",
  "Programowanie obiektowe i algorytmika",
];

const getLessons = async (librusApi) => {
  const getFirstMondayAfterPrevSep1 = () => {
    const now = new Date();
    let year = now.getFullYear();
    const sep1ThisYear = new Date(year, 8, 1);
    if (now < sep1ThisYear) year -= 1;
    const sep1 = new Date(year, 8, 1);

    const diff = (1 - sep1.getDay() + 7) % 7;
    const monday = new Date(sep1);
    monday.setDate(sep1.getDate() + diff);
    return monday;
  };

  const formatWeekStartQuery = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `weekStart=${y}-${m}-${d}`;
  };

  const now = new Date();
  const currentMonth = now.getMonth();

  let nextDate = getFirstMondayAfterPrevSep1();
  let lessons = [];

  do {
    try {
      const weekData = await librusApi.getTimetablesDate(
        formatWeekStartQuery(nextDate),
      );

      if (weekData && weekData.Timetable) {
        lessons.push(...proccessLessonTimetable(weekData.Timetable));
      }

      if (weekData && weekData.Pages && weekData.Pages.Next) {
        const nextQuery = weekData.Pages.Next.split("?")[1];
        const [_, datePart] = nextQuery.split("weekStart=");
        const [y, m, d] = datePart.split("-").map((x) => parseInt(x));
        nextDate = new Date(y, m - 1, d);
      } else {
        nextDate = null;
      }
    } catch (err) {
      console.error("Error fetching week data:", err);
      nextDate = null;
    }
  } while (nextDate && (nextDate.getMonth() >= 8 || nextDate.getMonth() < 6));

  return lessons;
};

const proccessLessonTimetable = (timetable) => {
  let entries = [];

  Object.entries(timetable).forEach(([key, value]) => {
    const date = key.split("-").map((x) => parseInt(x));
    value.forEach((events) => {
      events.forEach((event) => {
        if (blacklist.includes(event.Subject.Name)) return;
        if (event.IsCancelled) return;

        const subject = event.Subject.Name;
        const start = [
          ...date,
          ...event.HourFrom.split(":").map((x) => parseInt(x)),
        ];
        const end = [
          ...date,
          ...event.HourTo.split(":").map((x) => parseInt(x)),
        ];

        entries.push({
          uid: `${key}-${event.HourFrom}@lessons.librus`,
          description: `${event.Teacher.FirstName} ${event.Teacher.LastName}`,
          title: subject,
          start: start,
          end: end,
        });
      });
    });
  });
  return entries;
};

const getEvents = async (librusApi) => {
  const rawCategories = await librusApi.getHomeWorksCategories();
  const categories = {};
  rawCategories.Categories.forEach((category) => {
    categories[category.Id] = category.Name;
  });

  const rawSubjects = await librusApi.getSubjects();
  const subjects = {};
  rawSubjects.Subjects.forEach((subject) => {
    subjects[subject.Id] = subject;
  });
  const homeworksData = await librusApi.getHomeWorks();
  const homeworks = homeworksData.HomeWorks || [];
  const events = [];

  homeworks.forEach((homework) => {
    const date = homework.Date.split("-").map((x) => parseInt(x));
    const start = [
      ...date,
      ...homework.TimeFrom.split(":").map((x) => parseInt(x)),
    ];
    const end = [
      ...date,
      ...homework.TimeTo.split(":").map((x) => parseInt(x)),
    ];
    events.push({
      uid: homework.Id.toString() + "@events.librus",
      title:
        categories[homework.Category.Id] +
        (homework.Subject ? " - " + subjects[homework.Subject.Id].Name : ""),
      description: homework.Content,
      start: start,
      end: end,
    });
  });

  return events;
};

module.exports = {
  getLessons,
  getEvents,
};
